import { Router } from 'express';
import type Database from 'better-sqlite3';
import { AppConfig } from '../config.ts';
import { requireRole } from '../middleware/security.ts';
import { dispatchTransactionSms } from '../providers/smsProvider.ts';
import {
  generateId,
  hashPassword,
  maskAccountNumber,
  maskMobile,
  randomNumericCode,
  randomToken,
  sha256,
  verifyHmac,
} from '../security/crypto.ts';
import { recordAuditLog } from '../services/auditService.ts';
import {
  getAccountBalancePaise,
  LedgerError,
  reverseSettledTransaction,
  settlePendingTransaction,
  verifyLedgerZeroSum,
} from '../services/ledgerService.ts';

export function createManagerRouter(db: Database.Database, config: AppConfig): Router {
  const router = Router();
  router.use(requireRole(db, 'manager'));

  router.get('/overview', (_req, res) => {
    const zeroSum = verifyLedgerZeroSum(db);
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE role = 'user') AS customer_count,
           (SELECT COUNT(*) FROM users WHERE role = 'employee' AND status = 'active') AS active_employees,
           (SELECT COUNT(*) FROM employee_invites WHERE status = 'pending') AS pending_invites,
           (SELECT COUNT(*) FROM accounts WHERE account_type IN ('checking', 'savings')) AS customer_accounts,
           (SELECT COUNT(*) FROM ledger_transactions WHERE status = 'success') AS success_tx_count,
           (SELECT COUNT(*) FROM ledger_transactions WHERE status = 'pending') AS pending_tx_count,
           (SELECT COUNT(*) FROM ledger_transactions WHERE status = 'failed') AS failed_tx_count,
           (SELECT COUNT(*) FROM ledger_transactions WHERE status = 'reversed') AS reversed_tx_count`,
      )
      .get() as Record<string, number>;

    const recentActivity = db
      .prepare(
        `SELECT lt.id, lt.reference_code, lt.tx_type, lt.status, lt.amount_paise, lt.provider_name,
                lt.description, lt.created_at
         FROM ledger_transactions lt
         ORDER BY lt.created_at DESC
         LIMIT 12`,
      )
      .all();

    res.json({
      aggregates: {
        customerBalancesPaise: zeroSum.customerBalancesPaise,
        systemVaultBalancePaise: zeroSum.systemVaultBalancePaise,
        systemClearingBalancePaise: zeroSum.systemClearingBalancePaise,
        ledgerBalanced: zeroSum.balanced,
        totalDebitsPaise: zeroSum.totalDebitsPaise,
        totalCreditsPaise: zeroSum.totalCreditsPaise,
        customerCount: counts.customer_count,
        activeEmployees: counts.active_employees,
        pendingInvites: counts.pending_invites,
        customerAccounts: counts.customer_accounts,
        txCounts: {
          success: counts.success_tx_count,
          pending: counts.pending_tx_count,
          failed: counts.failed_tx_count,
          reversed: counts.reversed_tx_count,
        },
      },
      recentActivity,
      integrations: [
        {
          name: 'UPI & Mobile Resolution Gateway',
          mode: config.paymentProviderMode,
          configured: config.paymentProviderMode === 'live' ? Boolean(config.paymentProviderApiKey) : true,
          requirements: 'Requires NPCI/PSP partner onboarding, merchant VPA credentials, and signed webhook secret.',
        },
        {
          name: 'NEFT / IMPS / RTGS Banking Rails',
          mode: config.paymentProviderMode,
          configured: config.paymentProviderMode === 'live' ? Boolean(config.paymentProviderApiKey) : true,
          requirements: 'Requires sponsor bank corporate API onboarding, RBI/clearing approvals, and settlement reconciliation.',
        },
        {
          name: 'Aadhaar e-KYC Verification Provider',
          mode: config.kycProviderMode,
          configured: config.kycProviderMode === 'live' ? Boolean(config.kycProviderApiKey) : true,
          requirements: 'Requires licensed UIDAI KUA/ASA or DigiLocker partner credentials and regulatory compliance.',
        },
        {
          name: 'Transaction SMS Notification Gateway',
          mode: config.smsProviderMode,
          configured: config.smsProviderMode === 'live' ? Boolean(process.env.SMS_PROVIDER_ACCOUNT_SID) : true,
          requirements: 'Requires DLT template registration (India) and SMS provider SID/token environment variables.',
        },
      ],
    });
  });

  router.get('/employees', (_req, res) => {
    const employees = db
      .prepare(
        `SELECT id, username, full_name, email, mobile, status, department, created_at, updated_at
         FROM users
         WHERE role = 'employee'
         ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    const invites = db
      .prepare(
        `SELECT id, email, mobile, full_name, department, email_verified, mobile_verified, status, expires_at, created_at
         FROM employee_invites
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all();

    res.json({
      employees: employees.map((e) => ({
        id: e.id,
        username: e.username,
        fullName: e.full_name,
        email: e.email,
        mobile: maskMobile(e.mobile as string | null),
        status: e.status,
        department: e.department,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      })),
      invites,
    });
  });

  router.post('/employees/invite', (req, res) => {
    const { fullName, email, mobile, department } = (req.body || {}) as {
      fullName?: string;
      email?: string;
      mobile?: string;
      department?: string;
    };

    if (!fullName || !email || !mobile || !department) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Full name, Gmail address, mobile number, and department are required.',
      });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@gmail\.com$/i.test(cleanEmail)) {
      res.status(400).json({
        error: 'GMAIL_REQUIRED',
        message: 'Employee invitations require a valid @gmail.com address.',
      });
      return;
    }

    const cleanMobile = mobile.trim();
    if (!/^\+?\d{10,15}$/.test(cleanMobile)) {
      res.status(400).json({ error: 'INVALID_MOBILE', message: 'Provide a valid mobile number (e.g. +919800002222).' });
      return;
    }

    const existingUser = db
      .prepare('SELECT id FROM users WHERE lower(email) = ? OR mobile = ?')
      .get(cleanEmail, cleanMobile);
    if (existingUser) {
      res.status(409).json({ error: 'EMPLOYEE_EXISTS', message: 'An account with this email or mobile already exists.' });
      return;
    }

    const inviteId = generateId('inv');
    const rawInviteToken = randomToken(16);
    const emailCode = randomNumericCode(6);
    const mobileCode = randomNumericCode(6);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 48 * 3600_000).toISOString();

    db.prepare(`
      INSERT INTO employee_invites (
        id, email, mobile, full_name, department, invite_token_hash, email_code_hash, mobile_code_hash,
        invited_by, status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      inviteId,
      cleanEmail,
      cleanMobile,
      fullName.trim(),
      department.trim(),
      sha256(rawInviteToken),
      sha256(emailCode),
      sha256(mobileCode),
      req.authUser!.id,
      expiresAt,
      now.toISOString(),
      now.toISOString(),
    );

    recordAuditLog(db, {
      actorUserId: req.authUser!.id,
      actorRole: 'manager',
      action: 'EMPLOYEE_INVITED',
      targetType: 'employee_invite',
      targetId: inviteId,
      details: { email: cleanEmail, mobileMasked: maskMobile(cleanMobile), department: department.trim() },
      ipAddress: req.ip || null,
    });

    res.status(201).json({
      invite: {
        id: inviteId,
        email: cleanEmail,
        mobileMasked: maskMobile(cleanMobile),
        fullName: fullName.trim(),
        department: department.trim(),
        status: 'pending',
        expiresAt,
      },
      // Returned in non-production sandbox mode so local evaluators can verify contact codes end-to-end
      ...(config.allowDevSeed
        ? {
            sandboxVerification: {
              inviteToken: rawInviteToken,
              emailCode,
              mobileCode,
            },
          }
        : {}),
    });
  });

  router.patch('/employees/:id/status', (req, res) => {
    const { status, reason } = (req.body || {}) as { status?: 'active' | 'deactivated'; reason?: string };
    if (!status || !['active', 'deactivated'].includes(status)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Status must be active or deactivated.' });
      return;
    }

    if (!reason || reason.trim().length < 4) {
      res.status(400).json({ error: 'REASON_REQUIRED', message: 'Audit reason is required for access changes.' });
      return;
    }

    const emp = db
      .prepare(`SELECT id, username, full_name, role, status FROM users WHERE id = ? AND role = 'employee'`)
      .get(req.params.id) as { id: string; username: string; full_name: string; role: string; status: string } | undefined;

    if (!emp) {
      res.status(404).json({ error: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' });
      return;
    }

    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, now, emp.id);
      if (status === 'deactivated') {
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, emp.id);
      }
    })();

    recordAuditLog(db, {
      actorUserId: req.authUser!.id,
      actorRole: 'manager',
      action: status === 'deactivated' ? 'EMPLOYEE_DEACTIVATED' : 'EMPLOYEE_REACTIVATED',
      targetType: 'user',
      targetId: emp.id,
      details: { previousStatus: emp.status, newStatus: status, reason: reason.trim() },
      ipAddress: req.ip || null,
    });

    res.json({ ok: true, id: emp.id, status });
  });

  router.get('/customers', (_req, res) => {
    // Management-only minimal customer view: strictly omits auth secrets, raw KYC IDs, and provider tokens
    const rows = db
      .prepare(
        `SELECT u.id AS user_id, u.full_name, u.mobile, u.status AS user_status, u.kyc_status, u.created_at,
                a.id AS account_id, a.account_number, a.account_type, a.status AS account_status
         FROM users u
         JOIN accounts a ON a.user_id = u.id
         WHERE u.role = 'user'
         ORDER BY u.created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    res.json({
      customers: rows.map((r) => ({
        userId: r.user_id,
        fullName: r.full_name,
        mobileMasked: maskMobile(r.mobile as string | null),
        accountNumberMasked: maskAccountNumber(r.account_number as string),
        accountType: r.account_type,
        accountStatus: r.account_status,
        kycStatus: r.kyc_status,
        balancePaise: getAccountBalancePaise(db, r.account_id as string),
        createdAt: r.created_at,
      })),
    });
  });

  router.get('/transactions', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT lt.id, lt.reference_code, lt.tx_type, lt.status, lt.amount_paise, lt.currency,
                lt.external_destination, lt.provider_name, lt.provider_tx_ref, lt.description,
                lt.failure_reason, lt.reversed_transaction_id, lt.created_at, lt.completed_at,
                iu.full_name AS initiated_by_name, iu.role AS initiated_by_role
         FROM ledger_transactions lt
         LEFT JOIN users iu ON iu.id = lt.initiated_by_user_id
         ORDER BY lt.created_at DESC
         LIMIT 100`,
      )
      .all();
    res.json({ transactions: rows });
  });

  router.post('/transactions/:id/reverse', (req, res) => {
    const { reason } = (req.body || {}) as { reason?: string };
    try {
      const result = reverseSettledTransaction(db, req.params.id, req.authUser!.id, reason || '');
      recordAuditLog(db, {
        actorUserId: req.authUser!.id,
        actorRole: 'manager',
        action: 'TRANSACTION_REVERSED',
        targetType: 'transaction',
        targetId: result.original.id,
        details: {
          originalRef: result.original.reference_code,
          reversalRef: result.reversal.reference_code,
          amountPaise: result.original.amount_paise,
          reason,
        },
        ipAddress: req.ip || null,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  router.post('/transactions/:id/reconcile', (req, res) => {
    const { outcome, reason } = (req.body || {}) as { outcome?: 'success' | 'failed'; reason?: string };
    if (!outcome || !['success', 'failed'].includes(outcome)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Outcome must be success or failed.' });
      return;
    }

    try {
      const result = settlePendingTransaction(db, req.params.id, outcome, req.authUser!.id, reason);
      recordAuditLog(db, {
        actorUserId: req.authUser!.id,
        actorRole: 'manager',
        action: 'TRANSACTION_RECONCILED',
        targetType: 'transaction',
        targetId: result.original.id,
        details: { outcome, referenceCode: result.original.reference_code, reason },
        ipAddress: req.ip || null,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  router.get('/audit-logs', (_req, res) => {
    const logs = db
      .prepare(
        `SELECT al.*, u.username AS actor_username, u.full_name AS actor_name
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.actor_user_id
         ORDER BY al.created_at DESC
         LIMIT 150`,
      )
      .all();
    res.json({ logs });
  });

  router.get('/credentials', (_req, res) => {
    // Returns operational username and hashed-credential metadata for all users & employees;
    // NEVER exposes password_hash or plaintext passwords.
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.full_name, u.role, u.email, u.mobile, u.status,
                u.must_change_password, u.failed_login_attempts, u.locked_until,
                u.department, u.kyc_status, u.created_at, u.updated_at,
                a.account_number
         FROM users u
         LEFT JOIN accounts a ON a.user_id = u.id
         WHERE u.role IN ('user', 'employee')
         ORDER BY u.role ASC, u.created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    res.json({
      credentials: rows.map((r) => ({
        id: r.id,
        username: r.username,
        fullName: r.full_name,
        role: r.role,
        email: r.email,
        mobileMasked: maskMobile(r.mobile as string | null),
        accountMasked: r.account_number ? maskAccountNumber(r.account_number as string) : null,
        department: r.department,
        status: r.status,
        mustChangePassword: r.must_change_password === 1,
        failedLoginAttempts: r.failed_login_attempts,
        lockedUntil: r.locked_until,
        passwordProtection: 'scrypt-salted-hash',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  });

  router.post('/credentials/create', (req, res) => {
    const { username, fullName, email, mobile, role, temporaryPassword, department, accountType } = (req.body || {}) as {
      username?: string;
      fullName?: string;
      email?: string;
      mobile?: string;
      role?: 'user' | 'employee';
      temporaryPassword?: string;
      department?: string;
      accountType?: 'checking' | 'savings';
    };

    if (!username || !fullName || !email || !mobile || !role || !temporaryPassword) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Username, full name, email, mobile, role, and temporary password are required.',
      });
      return;
    }

    if (!['user', 'employee'].includes(role)) {
      res.status(400).json({ error: 'INVALID_ROLE', message: 'Role must be user or employee.' });
      return;
    }

    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{4,32}$/.test(cleanUsername)) {
      res.status(400).json({
        error: 'INVALID_USERNAME',
        message: 'Username must be 4-32 characters (letters, numbers, dot, underscore, hyphen).',
      });
      return;
    }

    if (temporaryPassword.length < 8) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Temporary password must be at least 8 characters.' });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanMobile = mobile.trim();

    if (role === 'employee' && !/^[a-z0-9._%+-]+@gmail\.com$/i.test(cleanEmail)) {
      res.status(400).json({
        error: 'GMAIL_REQUIRED',
        message: 'Employee credentials require a @gmail.com address.',
      });
      return;
    }

    const conflict = db
      .prepare('SELECT id FROM users WHERE lower(username) = ? OR lower(email) = ? OR mobile = ?')
      .get(cleanUsername, cleanEmail, cleanMobile);
    if (conflict) {
      res.status(409).json({ error: 'CREDENTIAL_EXISTS', message: 'Username, email, or mobile already exists.' });
      return;
    }

    const now = new Date().toISOString();
    const userId = generateId('usr');
    let createdAccountNumber: string | null = null;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO users (
          id, username, email, mobile, full_name, password_hash, role, status,
          must_change_password, sms_opt_in, email_opt_in, kyc_status, department, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, 1, 1, 'verified', ?, ?, ?)
      `).run(
        userId,
        cleanUsername,
        cleanEmail,
        cleanMobile,
        fullName.trim(),
        hashPassword(temporaryPassword),
        role,
        role === 'employee' ? (department?.trim() || 'Branch Operations') : null,
        now,
        now,
      );

      if (role === 'user') {
        const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM accounts WHERE account_type IN ('checking', 'savings')`).get() as {
          cnt: number;
        };
        createdAccountNumber = `MTB00${100001 + countRow.cnt + Math.floor(Math.random() * 50)}`;
        const upiHandle = `${cleanUsername.replace(/[^a-z0-9]/g, '')}@meridian`;
        db.prepare(`
          INSERT INTO accounts (
            id, account_number, user_id, account_type, currency, upi_handle, status,
            daily_transfer_limit_paise, per_tx_limit_paise, created_at
          ) VALUES (?, ?, ?, ?, 'INR', ?, 'active', 10000000, 5000000, ?)
        `).run(
          generateId('acct'),
          createdAccountNumber,
          userId,
          accountType === 'checking' ? 'checking' : 'savings',
          upiHandle,
          now,
        );
      }
    })();

    recordAuditLog(db, {
      actorUserId: req.authUser!.id,
      actorRole: 'manager',
      action: 'CREDENTIAL_CREATED_BY_MANAGER',
      targetType: 'user',
      targetId: userId,
      details: { username: cleanUsername, role, accountNumber: createdAccountNumber },
      ipAddress: req.ip || null,
    });

    res.status(201).json({
      credential: {
        id: userId,
        username: cleanUsername,
        fullName: fullName.trim(),
        role,
        accountNumber: createdAccountNumber,
        mustChangePassword: true,
      },
    });
  });

  router.post('/credentials/:id/reset-password', (req, res) => {
    const { temporaryPassword, reason } = (req.body || {}) as {
      temporaryPassword?: string;
      reason?: string;
    };

    if (!temporaryPassword || temporaryPassword.length < 8) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Temporary password must be at least 8 characters.' });
      return;
    }

    if (!reason || reason.trim().length < 4) {
      res.status(400).json({ error: 'REASON_REQUIRED', message: 'Audit reason is required for password reset.' });
      return;
    }

    const target = db
      .prepare(`SELECT id, username, role, mobile, sms_opt_in FROM users WHERE id = ? AND role IN ('user', 'employee')`)
      .get(req.params.id) as
      | { id: string; username: string; role: string; mobile: string | null; sms_opt_in: number }
      | undefined;

    if (!target) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'User or employee credential not found.' });
      return;
    }

    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(
        `UPDATE users
         SET password_hash = ?, must_change_password = 1, failed_login_attempts = 0, locked_until = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(hashPassword(temporaryPassword), now, target.id);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, target.id);
    })();

    dispatchTransactionSms(db, config, {
      userId: target.id,
      mobile: target.mobile,
      smsOptIn: true,
      message: `Meridian Trust Bank: A temporary password reset was issued for ${target.username}. You must set a new password at next login.`,
    });

    recordAuditLog(db, {
      actorUserId: req.authUser!.id,
      actorRole: 'manager',
      action: 'CREDENTIAL_PASSWORD_RESET',
      targetType: 'user',
      targetId: target.id,
      details: { targetUsername: target.username, targetRole: target.role, reason: reason.trim() },
      ipAddress: req.ip || null,
    });

    res.json({
      ok: true,
      message: `Temporary password updated (scrypt-hashed) for ${target.username}. Password change required on next login.`,
    });
  });

  router.post('/credentials/:id/unlock', (req, res) => {
    const target = db
      .prepare(`SELECT id, username, role FROM users WHERE id = ? AND role IN ('user', 'employee')`)
      .get(req.params.id) as { id: string; username: string; role: string } | undefined;

    if (!target) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'User or employee not found.' });
      return;
    }

    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      target.id,
    );

    recordAuditLog(db, {
      actorUserId: req.authUser!.id,
      actorRole: 'manager',
      action: 'CREDENTIAL_UNLOCKED',
      targetType: 'user',
      targetId: target.id,
      details: { targetUsername: target.username, targetRole: target.role },
      ipAddress: req.ip || null,
    });

    res.json({ ok: true, message: `Account ${target.username} unlocked.` });
  });

  return router;
}

export function createWebhookRouter(db: Database.Database, config: AppConfig): Router {
  const router = Router();

  router.post('/payment-provider', (req, res) => {
    const sig = req.headers['x-webhook-signature'];
    const rawBody = JSON.stringify(req.body || {});
    if (!sig || typeof sig !== 'string' || !verifyHmac(rawBody, sig, config.paymentWebhookSecret)) {
      res.status(401).json({ error: 'INVALID_WEBHOOK_SIGNATURE', message: 'Webhook HMAC verification failed.' });
      return;
    }

    const { transactionId, outcome, reason } = req.body as {
      transactionId?: string;
      outcome?: 'success' | 'failed';
      reason?: string;
    };

    if (!transactionId || !outcome || !['success', 'failed'].includes(outcome)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'transactionId and outcome (success|failed) required.' });
      return;
    }

    try {
      const txRow = db.prepare('SELECT initiated_by_user_id FROM ledger_transactions WHERE id = ?').get(transactionId) as
        | { initiated_by_user_id: string }
        | undefined;
      if (!txRow) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Transaction not found.' });
        return;
      }

      const settled = settlePendingTransaction(db, transactionId, outcome, txRow.initiated_by_user_id, reason);
      const user = db
        .prepare('SELECT id, mobile, sms_opt_in FROM users WHERE id = ?')
        .get(txRow.initiated_by_user_id) as { id: string; mobile: string | null; sms_opt_in: number } | undefined;

      if (user) {
        dispatchTransactionSms(db, config, {
          userId: user.id,
          mobile: user.mobile,
          smsOptIn: user.sms_opt_in === 1,
          transactionId: settled.original.id,
          message: `Payment ${settled.original.reference_code} settled with status: ${settled.original.status.toUpperCase()}.`,
        });
      }

      recordAuditLog(db, {
        actorUserId: null,
        actorRole: 'webhook',
        action: 'PAYMENT_WEBHOOK_SETTLED',
        targetType: 'transaction',
        targetId: settled.original.id,
        details: { outcome, referenceCode: settled.original.reference_code },
        ipAddress: req.ip || null,
      });

      res.json({ ok: true, transaction: settled.original });
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
