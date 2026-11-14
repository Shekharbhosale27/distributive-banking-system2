import { Router } from 'express';
import type Database from 'better-sqlite3';
import { AppConfig } from '../config.ts';
import { MAX_USER_ACCOUNTS, SYSTEM_VAULT_ACCOUNT_ID } from '../db/database.ts';
import { requireRole } from '../middleware/security.ts';
import { verifyAadhaarWithProvider } from '../providers/kycProvider.ts';
import { dispatchTransactionNotifications } from '../providers/emailProvider.ts';
import { generateId, hashPassword } from '../security/crypto.ts';
import { recordAuditLog } from '../services/auditService.ts';
import { getAccountBalancePaise, LedgerError, postDoubleEntryTransaction } from '../services/ledgerService.ts';

function generateNextAccountNumber(db: Database.Database): string {
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
  return `MTB00${seq}`;
}

export function createEmployeeRouter(db: Database.Database, config: AppConfig): Router {
  const router = Router();
  router.use(requireRole(db, 'employee'));

  router.get('/customers', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    let rows: Array<Record<string, unknown>>;

    if (q) {
      const like = `%${q}%`;
      rows = db
        .prepare(
          `SELECT u.id AS user_id, u.username, u.full_name, u.email, u.mobile, u.status AS user_status,
                  u.kyc_status, u.kyc_masked_id, u.created_at,
                  a.id AS account_id, a.account_number, a.account_type, a.upi_handle, a.status AS account_status
           FROM users u
           JOIN accounts a ON a.user_id = u.id
           WHERE u.role = 'user'
             AND (u.full_name LIKE ? OR a.account_number LIKE ? OR u.mobile LIKE ? OR u.username LIKE ?)
           ORDER BY u.created_at DESC
           LIMIT 50`,
        )
        .all(like, like, like, like) as Array<Record<string, unknown>>;
    } else {
      rows = db
        .prepare(
          `SELECT u.id AS user_id, u.username, u.full_name, u.email, u.mobile, u.status AS user_status,
                  u.kyc_status, u.kyc_masked_id, u.created_at,
                  a.id AS account_id, a.account_number, a.account_type, a.upi_handle, a.status AS account_status
           FROM users u
           JOIN accounts a ON a.user_id = u.id
           WHERE u.role = 'user'
           ORDER BY u.created_at DESC
           LIMIT 50`,
        )
        .all() as Array<Record<string, unknown>>;
    }

    const customers = rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      fullName: r.full_name,
      email: r.email,
      mobile: r.mobile,
      userStatus: r.user_status,
      kycStatus: r.kyc_status,
      kycMaskedId: r.kyc_masked_id,
      accountId: r.account_id,
      accountNumber: r.account_number,
      accountType: r.account_type,
      upiHandle: r.upi_handle,
      accountStatus: r.account_status,
      balancePaise: getAccountBalancePaise(db, r.account_id as string),
      createdAt: r.created_at,
    }));

    const totalUsers = (db.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'user'`).get() as { cnt: number }).cnt;
    res.json({
      customers,
      maxAdjustmentPaise: config.employeeMaxAdjustmentPaise,
      limits: {
        maxUsers: MAX_USER_ACCOUNTS,
        currentUsers: totalUsers,
      },
    });
  });

  router.get('/customers/:id', (req, res) => {
    const row = db
      .prepare(
        `SELECT u.id AS user_id, u.username, u.full_name, u.email, u.mobile, u.status AS user_status,
                u.kyc_status, u.kyc_masked_id, u.created_at,
                a.id AS account_id, a.account_number, a.account_type, a.upi_handle, a.status AS account_status,
                a.daily_transfer_limit_paise, a.per_tx_limit_paise
         FROM users u
         JOIN accounts a ON a.user_id = u.id
         WHERE u.id = ? AND u.role = 'user'`,
      )
      .get(req.params.id) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
      return;
    }

    const transactions = db
      .prepare(
        `SELECT lt.id, lt.reference_code, lt.tx_type, lt.status, lt.amount_paise, lt.currency,
                lt.source_account_id, lt.destination_account_id, lt.external_destination,
                lt.provider_name, lt.description, lt.failure_reason, lt.created_at, lt.completed_at,
                iu.full_name AS initiated_by_name
         FROM ledger_transactions lt
         LEFT JOIN users iu ON iu.id = lt.initiated_by_user_id
         WHERE lt.source_account_id = ? OR lt.destination_account_id = ?
         ORDER BY lt.created_at DESC
         LIMIT 50`,
      )
      .all(row.account_id, row.account_id);

    res.json({
      customer: {
        userId: row.user_id,
        username: row.username,
        fullName: row.full_name,
        email: row.email,
        mobile: row.mobile,
        userStatus: row.user_status,
        kycStatus: row.kyc_status,
        kycMaskedId: row.kyc_masked_id,
        accountId: row.account_id,
        accountNumber: row.account_number,
        accountType: row.account_type,
        upiHandle: row.upi_handle,
        accountStatus: row.account_status,
        dailyLimitPaise: row.daily_transfer_limit_paise,
        perTxLimitPaise: row.per_tx_limit_paise,
        balancePaise: getAccountBalancePaise(db, row.account_id as string),
        createdAt: row.created_at,
      },
      transactions,
      maxAdjustmentPaise: config.employeeMaxAdjustmentPaise,
    });
  });

  router.post('/customers', async (req, res) => {
    const {
      fullName,
      username,
      email,
      mobile,
      temporaryPassword,
      accountType,
      aadhaarNumber,
      openingDepositPaise,
      idempotencyKey,
    } = (req.body || {}) as {
      fullName?: string;
      username?: string;
      email?: string;
      mobile?: string;
      temporaryPassword?: string;
      accountType?: 'checking' | 'savings';
      aadhaarNumber?: string;
      openingDepositPaise?: number;
      idempotencyKey?: string;
    };

    if (!fullName || !username || !email || !mobile || !temporaryPassword || !aadhaarNumber) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Full name, username, email, mobile, temporary password, and Aadhaar number are required.',
      });
      return;
    }

    if (temporaryPassword.length < 8) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Temporary password must be at least 8 characters.' });
      return;
    }

    const cleanUsername = username.trim().toLowerCase();
    const cleanEmail = email.trim().toLowerCase();
    const cleanMobile = mobile.trim();
    const selectedType = accountType === 'savings' ? 'savings' : 'checking';

    const userCountBefore = (db.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'user'`).get() as { cnt: number }).cnt;
    if (userCountBefore >= MAX_USER_ACCOUNTS) {
      res.status(409).json({
        error: 'USER_LIMIT_REACHED',
        message: `Maximum capacity of ${MAX_USER_ACCOUNTS} user IDs reached. Ask a manager to delete an existing user first.`,
      });
      return;
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE lower(username) = ? OR lower(email) = ? OR mobile = ?')
      .get(cleanUsername, cleanEmail, cleanMobile);

    if (existing) {
      res.status(409).json({ error: 'CUSTOMER_EXISTS', message: 'Username, email, or mobile already exists.' });
      return;
    }

    // Verify Aadhaar via approved KYC provider adapter — NEVER store or log raw Aadhaar
    const kycResult = await verifyAadhaarWithProvider(aadhaarNumber, fullName.trim(), config);
    if (!kycResult.verified || !kycResult.providerRef) {
      recordAuditLog(db, {
        actorUserId: req.authUser!.id,
        actorRole: 'employee',
        action: 'CUSTOMER_KYC_REJECTED',
        targetType: 'kyc',
        targetId: kycResult.maskedId,
        details: { provider: kycResult.provider, reason: kycResult.message },
        ipAddress: req.ip || null,
      });
      res.status(422).json({
        error: 'KYC_VERIFICATION_FAILED',
        message: kycResult.message,
        kycMaskedId: kycResult.maskedId,
      });
      return;
    }

    const now = new Date().toISOString();
    const userId = generateId('usr');
    const accountId = generateId('acct');
    const accountNumber = generateNextAccountNumber(db);
    const upiHandle = `${cleanUsername.replace(/[^a-z0-9]/g, '')}@meridian`;

    try {
      db.transaction(() => {
        const currentUsers = (db.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'user'`).get() as { cnt: number }).cnt;
        if (currentUsers >= MAX_USER_ACCOUNTS) {
          const err = new Error(
            `Maximum capacity of ${MAX_USER_ACCOUNTS} user IDs reached. Ask a manager to delete an existing user first.`,
          ) as Error & { code?: string };
          err.code = 'USER_LIMIT_REACHED';
          throw err;
        }

        db.prepare(`
          INSERT INTO users (
            id, username, email, mobile, full_name, password_hash, role, status,
            must_change_password, sms_opt_in, email_opt_in, kyc_status, kyc_provider_ref, kyc_masked_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'user', 'active', 1, 1, 1, 'verified', ?, ?, ?, ?)
        `).run(
          userId,
          cleanUsername,
          cleanEmail,
          cleanMobile,
          fullName.trim(),
          hashPassword(temporaryPassword),
          kycResult.providerRef,
          kycResult.maskedId,
          now,
          now,
        );

        db.prepare(`
          INSERT INTO accounts (
            id, account_number, user_id, account_type, currency, upi_handle, status,
            daily_transfer_limit_paise, per_tx_limit_paise, created_at
          ) VALUES (?, ?, ?, ?, 'INR', ?, 'active', 10000000, 5000000, ?)
        `).run(accountId, accountNumber, userId, selectedType, upiHandle, now);
      }).immediate();
    } catch (err) {
      if ((err as { code?: string }).code === 'USER_LIMIT_REACHED') {
        res.status(409).json({ error: 'USER_LIMIT_REACHED', message: (err as Error).message });
        return;
      }
      throw err;
    }

    let openingTx = null;
    const depositAmount = openingDepositPaise ? Math.round(Number(openingDepositPaise)) : 0;
    if (depositAmount > 0) {
      if (depositAmount > config.employeeMaxAdjustmentPaise) {
        res.status(400).json({
          error: 'OPENING_DEPOSIT_LIMIT_EXCEEDED',
          message: `Opening deposit exceeds employee limit of INR ${(config.employeeMaxAdjustmentPaise / 100).toFixed(2)}.`,
        });
        return;
      }
      openingTx = postDoubleEntryTransaction(db, {
        idempotencyKey: `onboard:${idempotencyKey || userId}`,
        txType: 'opening_deposit',
        initialStatus: 'success',
        amountPaise: depositAmount,
        sourceAccountId: SYSTEM_VAULT_ACCOUNT_ID,
        destinationAccountId: accountId,
        providerName: 'internal',
        description: `Opening deposit on account creation by ${req.authUser!.fullName}`,
        initiatedByUserId: req.authUser!.id,
        enforceCustomerLimits: false,
      }).transaction;
    }

    await dispatchTransactionNotifications(db, config, {
      userId,
      mobile: cleanMobile,
      email: cleanEmail,
      smsOptIn: true,
      emailOptIn: true,
      transactionId: openingTx?.id,
      subject: `Welcome to Meridian Trust Bank — Account ${accountNumber} Opened`,
      message: `Welcome to Meridian Trust Bank. Account ${accountNumber} opened. Please change your temporary password at first login.`,
    });

    recordAuditLog(db, {
      actorUserId: req.authUser!.id,
      actorRole: 'employee',
      action: 'CUSTOMER_ONBOARDED',
      targetType: 'user',
      targetId: userId,
      details: {
        accountNumber,
        accountType: selectedType,
        kycProviderRef: kycResult.providerRef,
        kycMaskedId: kycResult.maskedId,
        openingDepositPaise: depositAmount,
      },
      ipAddress: req.ip || null,
    });

    res.status(201).json({
      customer: {
        userId,
        username: cleanUsername,
        fullName: fullName.trim(),
        email: cleanEmail,
        mobile: cleanMobile,
        kycStatus: 'verified',
        kycMaskedId: kycResult.maskedId,
        kycProviderRef: kycResult.providerRef,
        accountId,
        accountNumber,
        accountType: selectedType,
        upiHandle,
        balancePaise: getAccountBalancePaise(db, accountId),
      },
      openingTransaction: openingTx,
    });
  });

  router.post('/adjustments', async (req, res) => {
    const { accountId, action, amountPaise, reason, confirmed, idempotencyKey } = (req.body || {}) as {
      accountId?: string;
      action?: 'credit' | 'debit';
      amountPaise?: number;
      reason?: string;
      confirmed?: boolean;
      idempotencyKey?: string;
    };

    if (!accountId || !action || !['credit', 'debit'].includes(action) || !amountPaise || !idempotencyKey) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'accountId, action (credit|debit), amountPaise, reason, confirmed, and idempotencyKey are required.',
      });
      return;
    }

    if (confirmed !== true) {
      res.status(400).json({
        error: 'CONFIRMATION_REQUIRED',
        message: 'Explicit teller confirmation is required before posting an account credit or debit.',
      });
      return;
    }

    if (!reason || reason.trim().length < 6) {
      res.status(400).json({
        error: 'REASON_REQUIRED',
        message: 'An audit reason of at least 6 characters is required for every teller adjustment.',
      });
      return;
    }

    const intAmount = Math.round(Number(amountPaise));
    if (!Number.isInteger(intAmount) || intAmount <= 0) {
      res.status(400).json({ error: 'INVALID_AMOUNT', message: 'Amount must be positive.' });
      return;
    }

    if (intAmount > config.employeeMaxAdjustmentPaise) {
      res.status(403).json({
        error: 'EMPLOYEE_LIMIT_EXCEEDED',
        message: `Employee teller adjustment limit is INR ${(config.employeeMaxAdjustmentPaise / 100).toFixed(2)}. Manager escalation required for higher amounts.`,
      });
      return;
    }

    const customerAccount = db
      .prepare(
        `SELECT a.id, a.account_number, a.user_id, u.full_name, u.mobile, u.email, u.sms_opt_in, u.email_opt_in
         FROM accounts a
         JOIN users u ON u.id = a.user_id
         WHERE a.id = ? AND a.account_type IN ('checking', 'savings')`,
      )
      .get(accountId) as
      | {
          id: string;
          account_number: string;
          user_id: string;
          full_name: string;
          mobile: string | null;
          email: string | null;
          sms_opt_in: number;
          email_opt_in: number;
        }
      | undefined;

    if (!customerAccount) {
      res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', message: 'Customer account not found.' });
      return;
    }

    try {
      const result = postDoubleEntryTransaction(db, {
        idempotencyKey: `emp:${req.authUser!.id}:${idempotencyKey}`,
        txType: action === 'credit' ? 'employee_credit' : 'employee_debit',
        initialStatus: 'success',
        amountPaise: intAmount,
        sourceAccountId: action === 'credit' ? SYSTEM_VAULT_ACCOUNT_ID : customerAccount.id,
        destinationAccountId: action === 'credit' ? customerAccount.id : SYSTEM_VAULT_ACCOUNT_ID,
        providerName: 'teller_operations',
        description: `Teller ${action.toUpperCase()} by ${req.authUser!.fullName}: ${reason.trim()}`,
        initiatedByUserId: req.authUser!.id,
        enforceCustomerLimits: false,
        metadata: { reason: reason.trim(), employeeUsername: req.authUser!.username },
      });

      if (!result.idempotentReplay) {
        await dispatchTransactionNotifications(db, config, {
          userId: customerAccount.user_id,
          mobile: customerAccount.mobile,
          email: customerAccount.email,
          smsOptIn: customerAccount.sms_opt_in === 1,
          emailOptIn: customerAccount.email_opt_in === 1,
          transactionId: result.transaction.id,
          subject: `Teller ${action === 'credit' ? 'Credit' : 'Debit'}: INR ${(intAmount / 100).toFixed(2)} (${result.transaction.reference_code})`,
          message: `Account ${customerAccount.account_number} ${action === 'credit' ? 'credited' : 'debited'} INR ${(intAmount / 100).toFixed(2)}. Ref: ${result.transaction.reference_code}.`,
        });

        recordAuditLog(db, {
          actorUserId: req.authUser!.id,
          actorRole: 'employee',
          action: action === 'credit' ? 'TELLER_CREDIT' : 'TELLER_DEBIT',
          targetType: 'account',
          targetId: customerAccount.id,
          details: {
            referenceCode: result.transaction.reference_code,
            amountPaise: intAmount,
            reason: reason.trim(),
            customerUserId: customerAccount.user_id,
          },
          ipAddress: req.ip || null,
        });
      }

      res.status(result.idempotentReplay ? 200 : 201).json({
        idempotentReplay: result.idempotentReplay,
        transaction: result.transaction,
        balancePaise: getAccountBalancePaise(db, customerAccount.id),
      });
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  router.get('/help-tickets', (_req, res) => {
    const tickets = db
      .prepare(
        `SELECT ht.*, u.full_name AS customer_name, u.mobile AS customer_mobile
         FROM help_tickets ht
         JOIN users u ON u.id = ht.user_id
         ORDER BY CASE ht.status WHEN 'open' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END, ht.created_at DESC`,
      )
      .all();
    res.json({ tickets });
  });

  router.patch('/help-tickets/:id', (req, res) => {
    const { status, resolutionNote } = (req.body || {}) as {
      status?: 'open' | 'in_review' | 'resolved';
      resolutionNote?: string;
    };

    if (!status || !['open', 'in_review', 'resolved'].includes(status)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Valid ticket status is required.' });
      return;
    }

    const existing = db.prepare('SELECT * FROM help_tickets WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Help ticket not found.' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE help_tickets
       SET status = ?, resolution_note = COALESCE(?, resolution_note), assigned_employee_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(status, resolutionNote?.trim() || null, req.authUser!.id, now, req.params.id);

    recordAuditLog(db, {
      actorUserId: req.authUser!.id,
      actorRole: 'employee',
      action: 'HELP_TICKET_UPDATED',
      targetType: 'help_ticket',
      targetId: req.params.id,
      details: { status },
      ipAddress: req.ip || null,
    });

    res.json({ ticket: db.prepare('SELECT * FROM help_tickets WHERE id = ?').get(req.params.id) });
  });

  router.get('/transactions', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : 'all';

    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (status && status !== 'all' && ['pending', 'success', 'failed', 'reversed'].includes(status)) {
      whereClauses.push('lt.status = ?');
      params.push(status);
    }

    if (q) {
      const like = `%${q}%`;
      whereClauses.push(
        `(lt.reference_code LIKE ? OR lt.description LIKE ? OR COALESCE(sa.account_number, '') LIKE ? OR COALESCE(da.account_number, '') LIKE ? OR COALESCE(su.full_name, '') LIKE ? OR COALESCE(du.full_name, '') LIKE ? OR COALESCE(lt.external_destination, '') LIKE ?)`,
      );
      params.push(like, like, like, like, like, like, like);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const transactions = db
      .prepare(
        `SELECT lt.id, lt.reference_code, lt.tx_type, lt.status, lt.amount_paise, lt.currency,
                lt.external_destination, lt.provider_name, lt.provider_tx_ref, lt.description,
                lt.failure_reason, lt.reversed_transaction_id, lt.created_at, lt.completed_at,
                sa.account_number AS source_account_number, sa.account_type AS source_account_type,
                su.full_name AS source_owner_name,
                da.account_number AS destination_account_number, da.account_type AS destination_account_type,
                du.full_name AS destination_owner_name,
                iu.full_name AS initiated_by_name, iu.role AS initiated_by_role
         FROM ledger_transactions lt
         LEFT JOIN accounts sa ON sa.id = lt.source_account_id
         LEFT JOIN users su ON su.id = sa.user_id
         LEFT JOIN accounts da ON da.id = lt.destination_account_id
         LEFT JOIN users du ON du.id = da.user_id
         LEFT JOIN users iu ON iu.id = lt.initiated_by_user_id
         ${whereSql}
         ORDER BY lt.created_at DESC
         LIMIT 200`,
      )
      .all(...params);

    const totalRow = db.prepare(`SELECT COUNT(*) AS cnt FROM ledger_transactions lt LEFT JOIN accounts sa ON sa.id = lt.source_account_id LEFT JOIN users su ON su.id = sa.user_id LEFT JOIN accounts da ON da.id = lt.destination_account_id LEFT JOIN users du ON du.id = da.user_id ${whereSql}`).get(...params) as { cnt: number };

    res.json({ transactions, totalCount: totalRow.cnt });
  });

  return router;
}
