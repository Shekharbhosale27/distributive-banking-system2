import { Router } from 'express';
import type Database from 'better-sqlite3';
import { AppConfig } from '../config.ts';
import { MAX_EMPLOYEE_ACCOUNTS, MAX_USER_ACCOUNTS, SYSTEM_VAULT_ACCOUNT_ID } from '../db/database.ts';
import { requireRole } from '../middleware/security.ts';
import { isEmailLiveConfigured, resolveActiveEmailAdapter, dispatchTransactionEmail, dispatchTransactionNotifications } from '../providers/emailProvider.ts';
import { dispatchTransactionSms, isSmsLiveConfigured, resolveActiveSmsAdapter } from '../providers/smsProvider.ts';
import {
  generateId,
  generateReferenceCode,
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
          configured: config.smsProviderMode === 'live' ? isSmsLiveConfigured(config) : true,
          adapter: resolveActiveSmsAdapter(config),
          requirements: 'Supports Twilio, MSG91, Fast2SMS, or HTTP Webhook via SMS_PROVIDER_MODE=live and provider env credentials.',
        },
        {
          name: 'Gmail & Email Transaction Alert Gateway',
          mode: config.emailProviderMode,
          configured: config.emailProviderMode === 'live' ? isEmailLiveConfigured(config) : true,
          adapter: resolveActiveEmailAdapter(config),
          requirements: 'Supports 1P Google Workspace Gmail API (Google Sign-In OAuth) plus server-side Gmail SMTP, Resend, SendGrid, or HTTP Webhook.',
        },
      ],
    });
  });

  router.post('/integrations/test-notification', async (req, res) => {
    const { channel, recipient, message, confirmed } = (req.body || {}) as {
      channel?: 'sms' | 'email';
      recipient?: string;
      message?: string;
      confirmed?: boolean;
    };

    if (!channel || !['sms', 'email'].includes(channel) || !recipient) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'channel (sms|email) and recipient are required.' });
      return;
    }

    const cleanMsg =
      (message || 'Meridian Trust Bank diagnostic alert: Notification gateway verification check.').trim().slice(0, 300);

    if (channel === 'sms') {
      const result = await dispatchTransactionSms(db, config, {
        userId: req.authUser!.id,
        mobile: recipient.trim(),
        smsOptIn: true,
        message: cleanMsg,
      });
      res.status(result.status === 'failed' ? 502 : 200).json({ ok: result.status !== 'failed', result });
      return;
    }

    const gmailTokenHeader = req.headers['x-gmail-access-token'];
    const gmailAccessToken =
      typeof gmailTokenHeader === 'string' ? gmailTokenHeader.replace(/^Bearer\s+/i, '').trim() : undefined;

    if (gmailAccessToken && confirmed !== true) {
      res.status(400).json({
        error: 'CONFIRMATION_REQUIRED',
        message: 'Explicit confirmation is required before sending an email via your connected Gmail account.',
      });
      return;
    }

    const result = await dispatchTransactionEmail(db, config, {
      userId: req.authUser!.id,
      email: recipient.trim(),
      emailOptIn: true,
      subject: 'Meridian Trust Bank — Live Alert Diagnostic',
      message: cleanMsg,
      gmailAccessToken,
    });
    res.status(result.status === 'failed' ? 502 : 200).json({ ok: result.status !== 'failed', result });
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
      limits: {
        maxEmployees: MAX_EMPLOYEE_ACCOUNTS,
        currentEmployees: employees.length,
      },
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

    const empCount = (db.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'employee'`).get() as { cnt: number }).cnt;
    if (empCount >= MAX_EMPLOYEE_ACCOUNTS) {
      res.status(409).json({
        error: 'EMPLOYEE_LIMIT_REACHED',
        message: `Maximum capacity of ${MAX_EMPLOYEE_ACCOUNTS} employee IDs reached. Delete an existing employee first.`,
      });
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

    const mapped = rows.map((r) => ({
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
    }));

    const currentUsers = mapped.filter((c) => c.role === 'user').length;
    const currentEmployees = mapped.filter((c) => c.role === 'employee').length;

    res.json({
      credentials: mapped,
      limits: {
        maxUsers: MAX_USER_ACCOUNTS,
        maxEmployees: MAX_EMPLOYEE_ACCOUNTS,
        currentUsers,
        currentEmployees,
      },
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

    try {
      db.transaction(() => {
        const currentRoleCount = (
          db.prepare('SELECT COUNT(*) AS cnt FROM users WHERE role = ?').get(role) as { cnt: number }
        ).cnt;
        const maxAllowed = role === 'employee' ? MAX_EMPLOYEE_ACCOUNTS : MAX_USER_ACCOUNTS;
        if (currentRoleCount >= maxAllowed) {
          const err = new Error(
            role === 'employee'
              ? `Maximum capacity of ${MAX_EMPLOYEE_ACCOUNTS} employee IDs reached. Delete an existing employee first.`
              : `Maximum capacity of ${MAX_USER_ACCOUNTS} user IDs reached. Delete an existing user first.`,
          ) as Error & { code?: string };
          err.code = role === 'employee' ? 'EMPLOYEE_LIMIT_REACHED' : 'USER_LIMIT_REACHED';
          throw err;
        }

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
          const maxRow = db
            .prepare(
              `SELECT COALESCE(MAX(CAST(SUBSTR(account_number, 6) AS INTEGER)), 100000) AS max_seq
               FROM accounts
               WHERE account_number LIKE 'MTB00%'`,
            )
            .get() as { max_seq: number };
          let seq = maxRow.max_seq + 1;
          while (db.prepare('SELECT 1 FROM accounts WHERE account_number = ?').get(`MTB00${seq}`)) {
            seq += 1;
          }
          createdAccountNumber = `MTB00${seq}`;
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
      }).immediate();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'USER_LIMIT_REACHED' || code === 'EMPLOYEE_LIMIT_REACHED') {
        res.status(409).json({ error: code, message: (err as Error).message });
        return;
      }
      throw err;
    }

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

  router.post('/credentials/:id/reset-password', async (req, res) => {
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
      .prepare(`SELECT id, username, role, mobile, email, sms_opt_in, email_opt_in FROM users WHERE id = ? AND role IN ('user', 'employee')`)
      .get(req.params.id) as
      | {
          id: string;
          username: string;
          role: string;
          mobile: string | null;
          email: string | null;
          sms_opt_in: number;
          email_opt_in: number;
        }
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

    await dispatchTransactionNotifications(db, config, {
      userId: target.id,
      mobile: target.mobile,
      email: target.email,
      smsOptIn: true,
      emailOptIn: true,
      subject: `Meridian Trust Bank — Temporary Password Reset (${target.username})`,
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

  router.delete('/credentials/:id', (req, res) => {
    const { reason } = (req.body || {}) as { reason?: string };
    const cleanReason = reason?.trim() || 'Manager account deletion';
    if (cleanReason.length < 4) {
      res.status(400).json({ error: 'REASON_REQUIRED', message: 'Audit reason must be at least 4 characters.' });
      return;
    }

    const target = db
      .prepare(`SELECT id, username, full_name, role FROM users WHERE id = ? AND role IN ('user', 'employee')`)
      .get(req.params.id) as
      | { id: string; username: string; full_name: string; role: 'user' | 'employee' }
      | undefined;

    if (!target) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'User or employee account not found.' });
      return;
    }

    const managerId = req.authUser!.id;
    const now = new Date().toISOString();
    let totalSettledPaise = 0;

    db.transaction(() => {
      const userAccounts = db
        .prepare('SELECT id, account_number FROM accounts WHERE user_id = ?')
        .all(target.id) as Array<{ id: string; account_number: string }>;

      for (const acct of userAccounts) {
        const balancePaise = getAccountBalancePaise(db, acct.id);
        if (balancePaise > 0) {
          totalSettledPaise += balancePaise;
          const txId = generateId('tx');
          db.prepare(`
            INSERT INTO ledger_transactions (
              id, reference_code, idempotency_key, tx_type, status, amount_paise, currency,
              source_account_id, destination_account_id, external_destination, provider_name,
              provider_tx_ref, description, initiated_by_user_id, created_at, completed_at
            ) VALUES (?, ?, ?, 'employee_debit', 'success', ?, 'INR', ?, ?, NULL, 'internal', ?, ?, ?, ?, ?)
          `).run(
            txId,
            generateReferenceCode('CLS'),
            `acct_close_${acct.id}_${txId}`,
            balancePaise,
            acct.id,
            SYSTEM_VAULT_ACCOUNT_ID,
            `CLS-${acct.account_number}`,
            `Account closure settlement for deleted user ${target.username}: ${cleanReason}`,
            managerId,
            now,
            now,
          );

          const insertEntry = db.prepare(`
            INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount_paise, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `);
          insertEntry.run(generateId('le'), txId, acct.id, 'debit', balancePaise, now);
          insertEntry.run(generateId('le'), txId, SYSTEM_VAULT_ACCOUNT_ID, 'credit', balancePaise, now);
        }

        db.prepare(`UPDATE qr_payment_tokens SET status = 'expired' WHERE merchant_account_id = ? AND status = 'active'`).run(
          acct.id,
        );
      }

      db.prepare(`UPDATE accounts SET user_id = NULL, status = 'closed', upi_handle = NULL WHERE user_id = ?`).run(
        target.id,
      );

      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM password_recovery_tokens WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM notifications WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM help_tickets WHERE user_id = ?').run(target.id);
      db.prepare('UPDATE help_tickets SET assigned_employee_id = NULL WHERE assigned_employee_id = ?').run(target.id);
      db.prepare('UPDATE employee_invites SET accepted_user_id = NULL WHERE accepted_user_id = ?').run(target.id);
      db.prepare('UPDATE audit_logs SET actor_user_id = NULL WHERE actor_user_id = ?').run(target.id);
      db.prepare('UPDATE ledger_transactions SET initiated_by_user_id = ? WHERE initiated_by_user_id = ?').run(
        managerId,
        target.id,
      );

      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    }).immediate();

    recordAuditLog(db, {
      actorUserId: managerId,
      actorRole: 'manager',
      action: target.role === 'employee' ? 'EMPLOYEE_DELETED' : 'USER_DELETED',
      targetType: 'user',
      targetId: target.id,
      details: {
        deletedUsername: target.username,
        deletedFullName: target.full_name,
        deletedRole: target.role,
        settledBalancePaise: totalSettledPaise,
        reason: cleanReason,
      },
      ipAddress: req.ip || null,
    });

    res.json({
      ok: true,
      deleted: {
        id: target.id,
        username: target.username,
        role: target.role,
        settledBalancePaise: totalSettledPaise,
      },
      message: `${target.role === 'employee' ? 'Employee' : 'User'} ${target.username} deleted.`,
    });
  });

  router.get('/messages', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT n.id, n.user_id, u.username, u.full_name, u.role, n.channel, n.recipient_masked,
                n.message, n.provider, n.provider_message_id, n.status, n.error_message, n.created_at
         FROM notifications n
         JOIN users u ON u.id = n.user_id
         WHERE n.transaction_id IS NULL AND u.role IN ('user', 'employee')
         ORDER BY n.created_at DESC
         LIMIT 120`,
      )
      .all();

    res.json({ messages: rows });
  });

  router.post('/messages/send', async (req, res) => {
    const {
      audience = 'selected',
      recipientUserIds = [],
      channels = [],
      subject,
      message,
      confirmed,
    } = (req.body || {}) as {
      audience?: 'selected' | 'all_users' | 'all_employees' | 'all';
      recipientUserIds?: string[];
      channels?: Array<'sms' | 'email' | 'in_app'>;
      subject?: string;
      message?: string;
      confirmed?: boolean;
    };

    const validChannels = Array.isArray(channels)
      ? Array.from(new Set(channels.filter((c): c is 'sms' | 'email' | 'in_app' => ['sms', 'email', 'in_app'].includes(c))))
      : [];

    if (validChannels.length === 0) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Select at least one delivery channel (sms, email, or in_app).',
      });
      return;
    }

    const cleanMessage = (message || '').trim();
    if (cleanMessage.length < 3 || cleanMessage.length > 1000) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Message must be between 3 and 1000 characters.',
      });
      return;
    }

    const cleanSubject = (subject || 'Notice from Meridian Trust Bank Management').trim().slice(0, 140);

    const gmailTokenHeader = req.headers['x-gmail-access-token'];
    const gmailAccessToken =
      typeof gmailTokenHeader === 'string' ? gmailTokenHeader.replace(/^Bearer\s+/i, '').trim() : undefined;

    if (gmailAccessToken && validChannels.includes('email') && confirmed !== true) {
      res.status(400).json({
        error: 'CONFIRMATION_REQUIRED',
        message: 'Explicit confirmation is required before sending emails via your connected Gmail account.',
      });
      return;
    }

    if (!['selected', 'all_users', 'all_employees', 'all'].includes(audience)) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'audience must be selected, all_users, all_employees, or all.',
      });
      return;
    }

    type RecipientRow = {
      id: string;
      username: string;
      full_name: string;
      role: 'user' | 'employee';
      email: string | null;
      mobile: string | null;
    };

    let recipients: RecipientRow[] = [];
    if (audience === 'all') {
      recipients = db
        .prepare(
          `SELECT id, username, full_name, role, email, mobile
           FROM users
           WHERE role IN ('user', 'employee') AND status = 'active'
           ORDER BY role ASC, full_name ASC`,
        )
        .all() as RecipientRow[];
    } else if (audience === 'all_users') {
      recipients = db
        .prepare(
          `SELECT id, username, full_name, role, email, mobile
           FROM users
           WHERE role = 'user' AND status = 'active'
           ORDER BY full_name ASC`,
        )
        .all() as RecipientRow[];
    } else if (audience === 'all_employees') {
      recipients = db
        .prepare(
          `SELECT id, username, full_name, role, email, mobile
           FROM users
           WHERE role = 'employee' AND status = 'active'
           ORDER BY full_name ASC`,
        )
        .all() as RecipientRow[];
    } else {
      const cleanIds = Array.isArray(recipientUserIds)
        ? Array.from(new Set(recipientUserIds.map((id) => String(id).trim()).filter(Boolean)))
        : [];
      if (cleanIds.length === 0) {
        res.status(400).json({
          error: 'NO_RECIPIENTS',
          message: 'Select at least one active user or employee.',
        });
        return;
      }
      const placeholders = cleanIds.map(() => '?').join(', ');
      recipients = db
        .prepare(
          `SELECT id, username, full_name, role, email, mobile
           FROM users
           WHERE id IN (${placeholders}) AND role IN ('user', 'employee') AND status = 'active'
           ORDER BY full_name ASC`,
        )
        .all(...cleanIds) as RecipientRow[];
    }

    if (recipients.length === 0) {
      res.status(404).json({
        error: 'NO_ACTIVE_RECIPIENTS',
        message: 'No active user or employee recipients matched your selection.',
      });
      return;
    }

    let smsSent = 0;
    let emailSent = 0;
    let inAppSent = 0;
    let failedCount = 0;

    const results: Array<{
      userId: string;
      username: string;
      fullName: string;
      role: 'user' | 'employee';
      deliveries: Array<{
        channel: 'sms' | 'email' | 'in_app';
        status: string;
        provider: string;
        providerMessageId?: string | null;
        errorMessage?: string;
      }>;
    }> = [];

    const insertInAppStmt = db.prepare(`
      INSERT INTO notifications (
        id, user_id, transaction_id, channel, recipient_masked, message,
        provider, provider_message_id, status, error_message, created_at
      ) VALUES (?, ?, NULL, 'in_app', ?, ?, 'manager_portal', ?, 'sent', NULL, ?)
    `);

    for (const r of recipients) {
      const deliveries: Array<{
        channel: 'sms' | 'email' | 'in_app';
        status: string;
        provider: string;
        providerMessageId?: string | null;
        errorMessage?: string;
      }> = [];

      if (validChannels.includes('sms')) {
        const smsRes = await dispatchTransactionSms(db, config, {
          userId: r.id,
          mobile: r.mobile,
          smsOptIn: true,
          message: `${cleanSubject}: ${cleanMessage}`.slice(0, 480),
        });
        if (smsRes.status === 'failed') {
          failedCount += 1;
        } else {
          smsSent += 1;
        }
        deliveries.push({
          channel: 'sms',
          status: smsRes.status,
          provider: smsRes.provider,
          providerMessageId: smsRes.providerMessageId,
          errorMessage: smsRes.errorMessage,
        });
      }

      if (validChannels.includes('email')) {
        const emailRes = await dispatchTransactionEmail(db, config, {
          userId: r.id,
          email: r.email,
          emailOptIn: true,
          subject: cleanSubject,
          message: cleanMessage,
          gmailAccessToken,
        });
        if (emailRes.status === 'failed') {
          failedCount += 1;
        } else {
          emailSent += 1;
        }
        deliveries.push({
          channel: 'email',
          status: emailRes.status,
          provider: emailRes.provider,
          providerMessageId: emailRes.providerMessageId,
          errorMessage: emailRes.errorMessage,
        });
      }

      if (validChannels.includes('in_app')) {
        const notifId = generateId('ntf');
        const msgRef = generateReferenceCode('MSG');
        const formattedInApp = `[${cleanSubject}] ${cleanMessage}`;
        insertInAppStmt.run(notifId, r.id, r.username, formattedInApp, msgRef, new Date().toISOString());
        inAppSent += 1;
        deliveries.push({
          channel: 'in_app',
          status: 'sent',
          provider: 'manager_portal',
          providerMessageId: msgRef,
        });
      }

      results.push({
        userId: r.id,
        username: r.username,
        fullName: r.full_name,
        role: r.role,
        deliveries,
      });
    }

    recordAuditLog(db, {
      actorUserId: req.authUser!.id,
      actorRole: 'manager',
      action: 'MANAGER_MESSAGE_SENT',
      targetType: 'notification_broadcast',
      targetId: audience,
      details: {
        audience,
        channels: validChannels,
        subject: cleanSubject,
        recipientCount: recipients.length,
        recipientUsernames: recipients.map((r) => r.username).slice(0, 25),
        smsSent,
        emailSent,
        inAppSent,
        failedCount,
      },
      ipAddress: req.ip || null,
    });

    res.json({
      ok: true,
      summary: {
        totalRecipients: recipients.length,
        smsSent,
        emailSent,
        inAppSent,
        failedCount,
      },
      results,
    });
  });

  return router;
}

export function createWebhookRouter(db: Database.Database, config: AppConfig): Router {
  const router = Router();

  router.post('/payment-provider', async (req, res) => {
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
        .prepare('SELECT id, mobile, email, sms_opt_in, email_opt_in FROM users WHERE id = ?')
        .get(txRow.initiated_by_user_id) as
        | { id: string; mobile: string | null; email: string | null; sms_opt_in: number; email_opt_in: number }
        | undefined;

      if (user) {
        await dispatchTransactionNotifications(db, config, {
          userId: user.id,
          mobile: user.mobile,
          email: user.email,
          smsOptIn: user.sms_opt_in === 1,
          emailOptIn: user.email_opt_in === 1,
          transactionId: settled.original.id,
          subject: `Payment ${settled.original.reference_code} Settlement: ${settled.original.status.toUpperCase()}`,
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
