import { Router } from 'express';
import type Database from 'better-sqlite3';
import { AppConfig } from '../config.ts';
import { SYSTEM_CLEARING_ACCOUNT_ID } from '../db/database.ts';
import { createRateLimiter, requireAuth, requireRole } from '../middleware/security.ts';
import { resolveMobileViaProvider, submitBankTransferToProvider, submitUpiPaymentToProvider } from '../providers/paymentProvider.ts';
import { dispatchTransactionEmail, dispatchTransactionNotifications } from '../providers/emailProvider.ts';
import { generateId, maskAccountNumber, randomToken } from '../security/crypto.ts';
import { recordAuditLog } from '../services/auditService.ts';
import {
  getAccountBalancePaise,
  getDailyOutboundPaise,
  LedgerError,
  postDoubleEntryTransaction,
  settlePendingTransaction,
} from '../services/ledgerService.ts';
import { generateReceiveQr, inspectQrPayload } from '../services/qrService.ts';

function getPrimaryCustomerAccount(db: Database.Database, userId: string) {
  return db
    .prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
    .get(userId) as
    | {
        id: string;
        account_number: string;
        user_id: string;
        account_type: string;
        currency: string;
        upi_handle: string | null;
        status: string;
        daily_transfer_limit_paise: number;
        per_tx_limit_paise: number;
        created_at: string;
      }
    | undefined;
}

const FORBIDDEN_SECRET_FIELDS = ['password', 'pin', 'atmPin', 'upiPin', 'otp', 'cvv', 'bankingPassword'];

function rejectSecretFields(body: Record<string, unknown> | undefined): string | null {
  if (!body) return null;
  for (const field of FORBIDDEN_SECRET_FIELDS) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== '') {
      return `Security policy violation: field '${field}' must never be collected or transmitted to this application.`;
    }
  }
  return null;
}

export function createCustomerRouter(db: Database.Database, config: AppConfig): Router {
  const router = Router();
  const transferLimiter = createRateLimiter({ windowMs: 60_000, max: 30, keyPrefix: 'transfer' });

  router.get('/accounts/me', requireRole(db, 'user'), (req, res) => {
    const accounts = db
      .prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC')
      .all(req.authUser!.id) as Array<{
      id: string;
      account_number: string;
      account_type: string;
      currency: string;
      upi_handle: string | null;
      status: string;
      daily_transfer_limit_paise: number;
      per_tx_limit_paise: number;
      created_at: string;
    }>;

    const enriched = accounts.map((acct) => ({
      id: acct.id,
      accountNumber: acct.account_number,
      accountNumberMasked: maskAccountNumber(acct.account_number),
      accountType: acct.account_type,
      currency: acct.currency,
      upiHandle: acct.upi_handle,
      status: acct.status,
      balancePaise: getAccountBalancePaise(db, acct.id),
      dailyUsedPaise: getDailyOutboundPaise(db, acct.id),
      dailyLimitPaise: acct.daily_transfer_limit_paise,
      perTxLimitPaise: acct.per_tx_limit_paise,
      createdAt: acct.created_at,
    }));

    res.json({
      customer: {
        id: req.authUser!.id,
        fullName: req.authUser!.fullName,
        mobile: req.authUser!.mobile,
        email: req.authUser!.email,
        kycStatus: req.authUser!.kycStatus,
        smsOptIn: req.authUser!.smsOptIn,
        emailOptIn: req.authUser!.emailOptIn,
      },
      accounts: enriched,
    });
  });

  router.patch('/accounts/me/preferences', requireRole(db, 'user'), (req, res) => {
    const { smsOptIn, emailOptIn } = (req.body || {}) as { smsOptIn?: boolean; emailOptIn?: boolean };
    const nextSms = typeof smsOptIn === 'boolean' ? (smsOptIn ? 1 : 0) : req.authUser!.smsOptIn ? 1 : 0;
    const nextEmail = typeof emailOptIn === 'boolean' ? (emailOptIn ? 1 : 0) : req.authUser!.emailOptIn ? 1 : 0;

    db.prepare('UPDATE users SET sms_opt_in = ?, email_opt_in = ?, updated_at = ? WHERE id = ?').run(
      nextSms,
      nextEmail,
      new Date().toISOString(),
      req.authUser!.id,
    );

    recordAuditLog(db, {
      actorUserId: req.authUser!.id,
      actorRole: 'user',
      action: 'NOTIFICATION_PREFERENCES_UPDATED',
      targetType: 'user',
      targetId: req.authUser!.id,
      details: { smsOptIn: nextSms === 1, emailOptIn: nextEmail === 1 },
      ipAddress: req.ip || null,
    });

    res.json({ smsOptIn: nextSms === 1, emailOptIn: nextEmail === 1 });
  });

  router.get('/balances/me', requireRole(db, 'user'), (req, res) => {
    const acct = getPrimaryCustomerAccount(db, req.authUser!.id);
    if (!acct) {
      res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', message: 'No active account found.' });
      return;
    }
    const balancePaise = getAccountBalancePaise(db, acct.id);
    res.json({
      accountId: acct.id,
      accountNumber: acct.account_number,
      currency: acct.currency,
      balancePaise,
      dailyUsedPaise: getDailyOutboundPaise(db, acct.id),
      dailyLimitPaise: acct.daily_transfer_limit_paise,
    });
  });

  router.get('/transactions', requireAuth(), (req, res) => {
    const role = req.authUser!.role;
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;

    if (role === 'user') {
      const acct = getPrimaryCustomerAccount(db, req.authUser!.id);
      if (!acct) {
        res.json({ transactions: [] });
        return;
      }

      let sql = `
        SELECT lt.*,
               sa.account_number AS source_account_number,
               su.full_name AS source_owner_name,
               da.account_number AS destination_account_number,
               du.full_name AS destination_owner_name
        FROM ledger_transactions lt
        LEFT JOIN accounts sa ON sa.id = lt.source_account_id
        LEFT JOIN users su ON su.id = sa.user_id
        LEFT JOIN accounts da ON da.id = lt.destination_account_id
        LEFT JOIN users du ON du.id = da.user_id
        WHERE (lt.source_account_id = ? OR lt.destination_account_id = ?)
      `;
      const args: unknown[] = [acct.id, acct.id];
      if (statusFilter && ['pending', 'success', 'failed', 'reversed'].includes(statusFilter)) {
        sql += ' AND lt.status = ?';
        args.push(statusFilter);
      }
      sql += ' ORDER BY lt.created_at DESC LIMIT 100';

      const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
      const mapped = rows.map((row) => ({
        id: row.id,
        referenceCode: row.reference_code,
        txType: row.tx_type,
        status: row.status,
        direction: row.destination_account_id === acct.id ? 'credit' : 'debit',
        amountPaise: row.amount_paise,
        currency: row.currency,
        counterpartyName:
          row.destination_account_id === acct.id
            ? (row.source_owner_name as string) || 'Meridian Bank'
            : (row.destination_owner_name as string) || (row.external_destination as string) || 'External Recipient',
        counterpartyAccountMasked:
          row.destination_account_id === acct.id
            ? maskAccountNumber(row.source_account_number as string)
            : row.external_destination || maskAccountNumber(row.destination_account_number as string),
        providerName: row.provider_name,
        providerTxRef: row.provider_tx_ref,
        description: row.description,
        failureReason: row.failure_reason,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      }));
      res.json({ transactions: mapped });
      return;
    }

    // Employees/Managers querying /api/transactions get latest bank transactions (no secrets)
    let sql = `
      SELECT lt.*, sa.account_number AS source_account_number, da.account_number AS destination_account_number
      FROM ledger_transactions lt
      LEFT JOIN accounts sa ON sa.id = lt.source_account_id
      LEFT JOIN accounts da ON da.id = lt.destination_account_id
    `;
    const args: unknown[] = [];
    if (statusFilter && ['pending', 'success', 'failed', 'reversed'].includes(statusFilter)) {
      sql += ' WHERE lt.status = ?';
      args.push(statusFilter);
    }
    sql += ' ORDER BY lt.created_at DESC LIMIT 100';
    const rows = db.prepare(sql).all(...args);
    res.json({ transactions: rows });
  });

  router.get('/transactions/:id', requireAuth(), (req, res) => {
    const tx = db
      .prepare(
        `SELECT lt.*,
                sa.account_number AS source_account_number, sa.user_id AS source_user_id, su.full_name AS source_owner_name,
                da.account_number AS destination_account_number, da.user_id AS destination_user_id, du.full_name AS destination_owner_name
         FROM ledger_transactions lt
         LEFT JOIN accounts sa ON sa.id = lt.source_account_id
         LEFT JOIN users su ON su.id = sa.user_id
         LEFT JOIN accounts da ON da.id = lt.destination_account_id
         LEFT JOIN users du ON du.id = da.user_id
         WHERE lt.id = ? OR lt.reference_code = ?`,
      )
      .get(req.params.id, req.params.id) as Record<string, unknown> | undefined;

    if (!tx) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Transaction not found.' });
      return;
    }

    if (req.authUser!.role === 'user') {
      if (tx.source_user_id !== req.authUser!.id && tx.destination_user_id !== req.authUser!.id) {
        res.status(403).json({ error: 'FORBIDDEN', message: 'You are not authorized to view this transaction.' });
        return;
      }
    }

    const entries = db
      .prepare(
        `SELECT le.id, le.entry_type, le.amount_paise, le.created_at, a.account_number, a.account_type
         FROM ledger_entries le
         JOIN accounts a ON a.id = le.account_id
         WHERE le.transaction_id = ?`,
      )
      .all(tx.id as string) as Array<{
      id: string;
      entry_type: string;
      amount_paise: number;
      created_at: string;
      account_number: string;
      account_type: string;
    }>;

    res.json({
      transaction: {
        id: tx.id,
        referenceCode: tx.reference_code,
        txType: tx.tx_type,
        status: tx.status,
        amountPaise: tx.amount_paise,
        currency: tx.currency,
        sourceAccountMasked: maskAccountNumber(tx.source_account_number as string),
        sourceOwnerName: tx.source_owner_name || 'System Account',
        destinationAccountMasked: tx.external_destination || maskAccountNumber(tx.destination_account_number as string),
        destinationOwnerName: tx.destination_owner_name || tx.external_destination || 'Clearing Settlement',
        providerName: tx.provider_name,
        providerTxRef: tx.provider_tx_ref,
        description: tx.description,
        failureReason: tx.failure_reason,
        reversedTransactionId: tx.reversed_transaction_id,
        createdAt: tx.created_at,
        completedAt: tx.completed_at,
      },
      ledgerEntries: entries.map((e) => ({
        id: e.id,
        entryType: e.entry_type,
        amountPaise: e.amount_paise,
        accountMasked: e.account_type.startsWith('system_') ? e.account_number : maskAccountNumber(e.account_number),
        accountType: e.account_type,
        createdAt: e.created_at,
      })),
    });
  });

  router.post('/transfers/internal', requireRole(db, 'user'), transferLimiter, async (req, res) => {
    const secretViolation = rejectSecretFields(req.body);
    if (secretViolation) {
      res.status(400).json({ error: 'FORBIDDEN_FIELD', message: secretViolation });
      return;
    }

    const { destinationAccountNumber, amountPaise, description, idempotencyKey, sendGmailReceipt } = (req.body || {}) as {
      destinationAccountNumber?: string;
      amountPaise?: number;
      description?: string;
      idempotencyKey?: string;
      sendGmailReceipt?: boolean;
    };

    if (!destinationAccountNumber || !amountPaise || !idempotencyKey) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Destination account number, amountPaise, and idempotencyKey are required.',
      });
      return;
    }

    const srcAccount = getPrimaryCustomerAccount(db, req.authUser!.id);
    if (!srcAccount) {
      res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', message: 'Customer source account not found.' });
      return;
    }

    const dstAccount = db
      .prepare(
        `SELECT a.*, u.full_name, u.id AS owner_id, u.mobile AS owner_mobile, u.email AS owner_email,
                u.sms_opt_in AS owner_sms_opt_in, u.email_opt_in AS owner_email_opt_in
         FROM accounts a
         JOIN users u ON u.id = a.user_id
         WHERE a.account_number = ? AND u.status = 'active' AND a.status = 'active'`,
      )
      .get(destinationAccountNumber.trim().toUpperCase()) as
      | {
          id: string;
          account_number: string;
          full_name: string;
          owner_id: string;
          owner_mobile: string | null;
          owner_email: string | null;
          owner_sms_opt_in: number;
          owner_email_opt_in: number;
        }
      | undefined;

    if (!dstAccount) {
      res.status(404).json({ error: 'RECIPIENT_NOT_FOUND', message: 'Active destination account not found.' });
      return;
    }

    const gmailToken =
      sendGmailReceipt === true && typeof req.headers['x-gmail-access-token'] === 'string'
        ? req.headers['x-gmail-access-token'].trim()
        : undefined;

    try {
      const result = postDoubleEntryTransaction(db, {
        idempotencyKey: `usr:${req.authUser!.id}:${idempotencyKey}`,
        txType: 'internal_transfer',
        initialStatus: 'success',
        amountPaise: Math.round(Number(amountPaise)),
        sourceAccountId: srcAccount.id,
        destinationAccountId: dstAccount.id,
        providerName: 'internal',
        providerTxRef: `INT-${randomToken(6).toUpperCase()}`,
        description: (description || `Transfer to ${dstAccount.full_name}`).trim().slice(0, 140),
        initiatedByUserId: req.authUser!.id,
      });

      if (!result.idempotentReplay) {
        const senderMsg = `INR ${(result.transaction.amount_paise / 100).toFixed(2)} sent to ${dstAccount.full_name} (${maskAccountNumber(dstAccount.account_number)}). Ref: ${result.transaction.reference_code}.`;
        const recipientMsg = `INR ${(result.transaction.amount_paise / 100).toFixed(2)} credited from ${req.authUser!.fullName}. Ref: ${result.transaction.reference_code}.`;

        await Promise.all([
          dispatchTransactionNotifications(db, config, {
            userId: req.authUser!.id,
            mobile: req.authUser!.mobile,
            email: req.authUser!.email,
            smsOptIn: req.authUser!.smsOptIn,
            emailOptIn: req.authUser!.emailOptIn,
            transactionId: result.transaction.id,
            subject: `Debit Alert: INR ${(result.transaction.amount_paise / 100).toFixed(2)} Sent (${result.transaction.reference_code})`,
            message: senderMsg,
            gmailAccessToken: gmailToken,
          }),
          dispatchTransactionNotifications(db, config, {
            userId: dstAccount.owner_id,
            mobile: dstAccount.owner_mobile,
            email: dstAccount.owner_email,
            smsOptIn: dstAccount.owner_sms_opt_in === 1,
            emailOptIn: dstAccount.owner_email_opt_in === 1,
            transactionId: result.transaction.id,
            subject: `Credit Alert: INR ${(result.transaction.amount_paise / 100).toFixed(2)} Received (${result.transaction.reference_code})`,
            message: recipientMsg,
          }),
        ]);
        recordAuditLog(db, {
          actorUserId: req.authUser!.id,
          actorRole: 'user',
          action: 'INTERNAL_TRANSFER',
          targetType: 'transaction',
          targetId: result.transaction.id,
          details: { amountPaise: result.transaction.amount_paise, referenceCode: result.transaction.reference_code },
          ipAddress: req.ip || null,
        });
      }

      res.status(result.idempotentReplay ? 200 : 201).json({
        idempotentReplay: result.idempotentReplay,
        transaction: result.transaction,
        balancePaise: getAccountBalancePaise(db, srcAccount.id),
      });
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  router.post('/transfers/resolve-mobile', requireRole(db, 'user'), async (req, res) => {
    const { mobile } = (req.body || {}) as { mobile?: string };
    if (!mobile || !/^\+?\d{10,15}$/.test(mobile.trim())) {
      res.status(400).json({ error: 'INVALID_MOBILE', message: 'Provide a valid mobile number with country code (e.g. +919800001002).' });
      return;
    }

    const resolved = await resolveMobileViaProvider(mobile.trim(), db, config);
    if (!resolved.resolved) {
      res.status(404).json({ error: 'MOBILE_NOT_RESOLVED', ...resolved });
      return;
    }
    res.json(resolved);
  });

  router.post('/transfers/upi', requireRole(db, 'user'), transferLimiter, async (req, res) => {
    const secretViolation = rejectSecretFields(req.body);
    if (secretViolation) {
      res.status(400).json({ error: 'FORBIDDEN_FIELD', message: secretViolation });
      return;
    }

    const { upiHandle, mobile, amountPaise, description, idempotencyKey, sendGmailReceipt } = (req.body || {}) as {
      upiHandle?: string;
      mobile?: string;
      amountPaise?: number;
      description?: string;
      idempotencyKey?: string;
      sendGmailReceipt?: boolean;
    };

    if (!amountPaise || !idempotencyKey || (!upiHandle && !mobile)) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Provide upiHandle or resolved mobile, amountPaise, and idempotencyKey.',
      });
      return;
    }

    const gmailToken =
      sendGmailReceipt === true && typeof req.headers['x-gmail-access-token'] === 'string'
        ? req.headers['x-gmail-access-token'].trim()
        : undefined;

    const srcAccount = getPrimaryCustomerAccount(db, req.authUser!.id);
    if (!srcAccount) {
      res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', message: 'Source account not found.' });
      return;
    }

    let targetVpa = upiHandle?.trim().toLowerCase() || '';
    let txType: 'upi_transfer' | 'mobile_transfer' = 'upi_transfer';
    let resolvedInternalId: string | undefined;

    if (mobile && !targetVpa) {
      txType = 'mobile_transfer';
      const resolved = await resolveMobileViaProvider(mobile.trim(), db, config);
      if (!resolved.resolved || !resolved.upiHandle) {
        res.status(400).json({
          error: 'MOBILE_RESOLUTION_REQUIRED',
          message: resolved.message,
        });
        return;
      }
      targetVpa = resolved.upiHandle.toLowerCase();
      resolvedInternalId = resolved.internalAccountId;
    }

    if (!/^[a-z0-9._-]{2,}@[a-z0-9.-]{2,}$/i.test(targetVpa)) {
      res.status(400).json({ error: 'INVALID_UPI_HANDLE', message: 'Provide a valid UPI ID (e.g., name@bank).' });
      return;
    }

    // Check if target UPI handle belongs to an internal Meridian account
    const internalAcct = resolvedInternalId
      ? (db
          .prepare(
            `SELECT a.id, a.user_id, a.account_number, u.mobile AS owner_mobile, u.email AS owner_email, u.sms_opt_in, u.email_opt_in
             FROM accounts a JOIN users u ON u.id = a.user_id
             WHERE a.id = ? AND a.status = 'active'`,
          )
          .get(resolvedInternalId) as
          | {
              id: string;
              user_id: string;
              account_number: string;
              owner_mobile: string | null;
              owner_email: string | null;
              sms_opt_in: number;
              email_opt_in: number;
            }
          | undefined)
      : (db
          .prepare(
            `SELECT a.id, a.user_id, a.account_number, u.mobile AS owner_mobile, u.email AS owner_email, u.sms_opt_in, u.email_opt_in
             FROM accounts a JOIN users u ON u.id = a.user_id
             WHERE lower(a.upi_handle) = ? AND a.status = 'active'`,
          )
          .get(targetVpa) as
          | {
              id: string;
              user_id: string;
              account_number: string;
              owner_mobile: string | null;
              owner_email: string | null;
              sms_opt_in: number;
              email_opt_in: number;
            }
          | undefined);

    if (internalAcct) {
      try {
        const result = postDoubleEntryTransaction(db, {
          idempotencyKey: `usr:${req.authUser!.id}:${idempotencyKey}`,
          txType,
          initialStatus: 'success',
          amountPaise: Math.round(Number(amountPaise)),
          sourceAccountId: srcAccount.id,
          destinationAccountId: internalAcct.id,
          externalDestination: targetVpa,
          providerName: 'internal_upi',
          providerTxRef: `IUPI-${randomToken(6).toUpperCase()}`,
          description: (description || `UPI payment to ${targetVpa}`).trim().slice(0, 140),
          initiatedByUserId: req.authUser!.id,
        });

        if (!result.idempotentReplay) {
          const amtText = (result.transaction.amount_paise / 100).toFixed(2);
          await Promise.all([
            dispatchTransactionNotifications(db, config, {
              userId: req.authUser!.id,
              mobile: req.authUser!.mobile,
              email: req.authUser!.email,
              smsOptIn: req.authUser!.smsOptIn,
              emailOptIn: req.authUser!.emailOptIn,
              transactionId: result.transaction.id,
              subject: `UPI Debit Alert: INR ${amtText} to ${targetVpa} (${result.transaction.reference_code})`,
              message: `INR ${amtText} paid via UPI to ${targetVpa}. Ref: ${result.transaction.reference_code}.`,
              gmailAccessToken: gmailToken,
            }),
            dispatchTransactionNotifications(db, config, {
              userId: internalAcct.user_id,
              mobile: internalAcct.owner_mobile,
              email: internalAcct.owner_email,
              smsOptIn: internalAcct.sms_opt_in === 1,
              emailOptIn: internalAcct.email_opt_in === 1,
              transactionId: result.transaction.id,
              subject: `UPI Credit Alert: INR ${amtText} Received (${result.transaction.reference_code})`,
              message: `INR ${amtText} credited via UPI from ${req.authUser!.fullName}. Ref: ${result.transaction.reference_code}.`,
            }),
          ]);
        }

        res.status(result.idempotentReplay ? 200 : 201).json({
          idempotentReplay: result.idempotentReplay,
          transaction: result.transaction,
          balancePaise: getAccountBalancePaise(db, srcAccount.id),
          providerNote: 'Settled internally to Meridian Trust Bank UPI handle.',
        });
        return;
      } catch (err) {
        if (err instanceof LedgerError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        throw err;
      }
    }

    // External UPI payment via configured provider adapter:
    // First hold funds atomically in clearing (`pending`) so balance/limits are checked before external call
    const scopedKey = `usr:${req.authUser!.id}:${idempotencyKey}`;
    const existing = db.prepare('SELECT * FROM ledger_transactions WHERE idempotency_key = ?').get(scopedKey);
    if (existing) {
      res.status(200).json({
        idempotentReplay: true,
        transaction: existing,
        balancePaise: getAccountBalancePaise(db, srcAccount.id),
      });
      return;
    }

    let heldResult;
    try {
      heldResult = postDoubleEntryTransaction(db, {
        idempotencyKey: scopedKey,
        txType,
        initialStatus: 'pending',
        amountPaise: Math.round(Number(amountPaise)),
        sourceAccountId: srcAccount.id,
        destinationAccountId: SYSTEM_CLEARING_ACCOUNT_ID,
        externalDestination: targetVpa,
        providerName: config.paymentProviderMode === 'live' ? 'npci_upi_live' : 'upi_gateway_sandbox',
        description: (description || `UPI payment to ${targetVpa}`).trim().slice(0, 140),
        initiatedByUserId: req.authUser!.id,
      });
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    const providerOutcome = await submitUpiPaymentToProvider(
      {
        upiHandle: targetVpa,
        amountPaise: heldResult.transaction.amount_paise,
        referenceCode: heldResult.transaction.reference_code,
        note: heldResult.transaction.description,
      },
      config,
    );

    db.prepare('UPDATE ledger_transactions SET provider_tx_ref = ? WHERE id = ?').run(
      providerOutcome.providerTxRef,
      heldResult.transaction.id,
    );

    let finalTx = heldResult.transaction;
    if (providerOutcome.status === 'success') {
      finalTx = settlePendingTransaction(db, heldResult.transaction.id, 'success', req.authUser!.id).original;
    } else if (providerOutcome.status === 'failed') {
      finalTx = settlePendingTransaction(
        db,
        heldResult.transaction.id,
        'failed',
        req.authUser!.id,
        providerOutcome.message,
      ).original;
    }

    await dispatchTransactionNotifications(db, config, {
      userId: req.authUser!.id,
      mobile: req.authUser!.mobile,
      email: req.authUser!.email,
      smsOptIn: req.authUser!.smsOptIn,
      emailOptIn: req.authUser!.emailOptIn,
      transactionId: finalTx.id,
      subject: `UPI Transfer ${finalTx.status.toUpperCase()}: INR ${(finalTx.amount_paise / 100).toFixed(2)} (${finalTx.reference_code})`,
      message: `UPI transfer ${finalTx.reference_code} to ${targetVpa} for INR ${(finalTx.amount_paise / 100).toFixed(2)} status: ${finalTx.status.toUpperCase()}.`,
      gmailAccessToken: gmailToken,
    });

    res.status(201).json({
      idempotentReplay: false,
      transaction: finalTx,
      balancePaise: getAccountBalancePaise(db, srcAccount.id),
      providerNote: providerOutcome.message,
    });
  });

  router.post('/transfers/bank', requireRole(db, 'user'), transferLimiter, async (req, res) => {
    const secretViolation = rejectSecretFields(req.body);
    if (secretViolation) {
      res.status(400).json({ error: 'FORBIDDEN_FIELD', message: secretViolation });
      return;
    }

    const { beneficiaryName, accountNumber, ifscCode, rail, amountPaise, description, idempotencyKey, sendGmailReceipt } = (req.body || {}) as {
      beneficiaryName?: string;
      accountNumber?: string;
      ifscCode?: string;
      rail?: 'IMPS' | 'NEFT' | 'RTGS';
      amountPaise?: number;
      description?: string;
      idempotencyKey?: string;
      sendGmailReceipt?: boolean;
    };

    if (!beneficiaryName || !accountNumber || !ifscCode || !amountPaise || !idempotencyKey) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Beneficiary name, account number, IFSC code, amountPaise, and idempotencyKey are required.',
      });
      return;
    }

    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(ifscCode.trim())) {
      res.status(400).json({ error: 'INVALID_IFSC', message: 'IFSC code must match standard 11-character format (e.g. HDFC0001234).' });
      return;
    }

    const gmailToken =
      sendGmailReceipt === true && typeof req.headers['x-gmail-access-token'] === 'string'
        ? req.headers['x-gmail-access-token'].trim()
        : undefined;

    const selectedRail: 'IMPS' | 'NEFT' | 'RTGS' = rail && ['IMPS', 'NEFT', 'RTGS'].includes(rail) ? rail : 'NEFT';
    const srcAccount = getPrimaryCustomerAccount(db, req.authUser!.id);
    if (!srcAccount) {
      res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', message: 'Source account not found.' });
      return;
    }

    const scopedKey = `usr:${req.authUser!.id}:${idempotencyKey}`;
    const existing = db.prepare('SELECT * FROM ledger_transactions WHERE idempotency_key = ?').get(scopedKey);
    if (existing) {
      res.status(200).json({
        idempotentReplay: true,
        transaction: existing,
        balancePaise: getAccountBalancePaise(db, srcAccount.id),
      });
      return;
    }

    const maskedDest = `${ifscCode.trim().toUpperCase().slice(0, 4)}${maskAccountNumber(accountNumber.trim())} (${selectedRail})`;

    let held;
    try {
      held = postDoubleEntryTransaction(db, {
        idempotencyKey: scopedKey,
        txType: 'bank_transfer',
        initialStatus: 'pending',
        amountPaise: Math.round(Number(amountPaise)),
        sourceAccountId: srcAccount.id,
        destinationAccountId: SYSTEM_CLEARING_ACCOUNT_ID,
        externalDestination: maskedDest,
        providerName: config.paymentProviderMode === 'live' ? 'bank_rails_live' : 'bank_rails_sandbox',
        description: (description || `${selectedRail} to ${beneficiaryName.trim()}`).trim().slice(0, 140),
        initiatedByUserId: req.authUser!.id,
        metadata: { rail: selectedRail, beneficiaryName: beneficiaryName.trim() },
      });
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    const providerOutcome = await submitBankTransferToProvider(
      {
        beneficiaryName: beneficiaryName.trim(),
        accountNumber: accountNumber.trim(),
        ifscCode: ifscCode.trim().toUpperCase(),
        rail: selectedRail,
        amountPaise: held.transaction.amount_paise,
        referenceCode: held.transaction.reference_code,
      },
      config,
    );

    db.prepare('UPDATE ledger_transactions SET provider_tx_ref = ? WHERE id = ?').run(
      providerOutcome.providerTxRef,
      held.transaction.id,
    );

    let finalTx = held.transaction;
    if (providerOutcome.status === 'failed') {
      finalTx = settlePendingTransaction(
        db,
        held.transaction.id,
        'failed',
        req.authUser!.id,
        providerOutcome.message,
      ).original;
    } else if (providerOutcome.status === 'success') {
      finalTx = settlePendingTransaction(db, held.transaction.id, 'success', req.authUser!.id).original;
    } else {
      finalTx = db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(held.transaction.id) as typeof finalTx;
    }

    await dispatchTransactionNotifications(db, config, {
      userId: req.authUser!.id,
      mobile: req.authUser!.mobile,
      email: req.authUser!.email,
      smsOptIn: req.authUser!.smsOptIn,
      emailOptIn: req.authUser!.emailOptIn,
      transactionId: finalTx.id,
      subject: `${selectedRail} Transfer ${finalTx.status.toUpperCase()}: INR ${(finalTx.amount_paise / 100).toFixed(2)} (${finalTx.reference_code})`,
      message: `${selectedRail} transfer ${finalTx.reference_code} for INR ${(finalTx.amount_paise / 100).toFixed(2)} is ${finalTx.status.toUpperCase()}.`,
      gmailAccessToken: gmailToken,
    });

    res.status(201).json({
      idempotentReplay: false,
      transaction: finalTx,
      balancePaise: getAccountBalancePaise(db, srcAccount.id),
      providerNote: providerOutcome.message,
    });
  });

  router.post('/qr/generate', requireRole(db, 'user'), async (req, res) => {
    const { amountPaise, note } = (req.body || {}) as { amountPaise?: number | null; note?: string };
    const acct = getPrimaryCustomerAccount(db, req.authUser!.id);
    if (!acct) {
      res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' });
      return;
    }

    let validatedAmount: number | null = null;
    if (amountPaise !== undefined && amountPaise !== null && Number(amountPaise) > 0) {
      validatedAmount = Math.round(Number(amountPaise));
    }

    const qr = await generateReceiveQr(db, config, {
      accountId: acct.id,
      upiHandle: acct.upi_handle || `${req.authUser!.username}@meridian`,
      recipientName: req.authUser!.fullName,
      amountPaise: validatedAmount,
      note: note ? note.trim().slice(0, 80) : null,
    });

    res.status(201).json(qr);
  });

  router.post('/qr/inspect', requireRole(db, 'user'), (req, res) => {
    const { payload } = (req.body || {}) as { payload?: string };
    if (!payload || typeof payload !== 'string') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'QR payload string is required.' });
      return;
    }

    const inspected = inspectQrPayload(db, config, payload);
    if (!inspected.valid) {
      res.status(400).json({ error: 'INVALID_QR', message: inspected.reason });
      return;
    }

    // Explicitly returns recipient & amount for review — NEVER triggers payment here.
    res.json({
      valid: true,
      requiresConfirmation: true,
      token: inspected.token,
      recipientName: inspected.recipientName,
      upiHandle: inspected.upiHandle,
      merchantAccountMasked: inspected.merchantAccountMasked,
      amountPaise: inspected.amountPaise,
      note: inspected.note,
      expiresAt: inspected.expiresAt,
    });
  });

  router.post('/qr/pay', requireRole(db, 'user'), transferLimiter, async (req, res) => {
    const { payload, amountPaise, confirmed, idempotencyKey } = (req.body || {}) as {
      payload?: string;
      amountPaise?: number;
      confirmed?: boolean;
      idempotencyKey?: string;
    };

    if (confirmed !== true) {
      res.status(400).json({
        error: 'CONFIRMATION_REQUIRED',
        message: 'Explicit user confirmation is required to authorize QR payment.',
      });
      return;
    }

    if (!payload || !idempotencyKey) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'QR payload and idempotencyKey are required.' });
      return;
    }

    const srcAccount = getPrimaryCustomerAccount(db, req.authUser!.id);
    if (!srcAccount) {
      res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', message: 'Source account not found.' });
      return;
    }

    const scopedKey = `usr:${req.authUser!.id}:${idempotencyKey}`;
    const existing = db.prepare('SELECT * FROM ledger_transactions WHERE idempotency_key = ?').get(scopedKey);
    if (existing) {
      res.status(200).json({
        idempotentReplay: true,
        transaction: existing,
        balancePaise: getAccountBalancePaise(db, srcAccount.id),
      });
      return;
    }

    const inspected = inspectQrPayload(db, config, payload);
    if (!inspected.valid || !inspected.merchantAccountId || !inspected.token) {
      res.status(400).json({ error: 'INVALID_QR', message: inspected.reason || 'Invalid QR code.' });
      return;
    }

    const finalAmountPaise = inspected.amountPaise ?? (amountPaise ? Math.round(Number(amountPaise)) : 0);
    if (!finalAmountPaise || finalAmountPaise <= 0) {
      res.status(400).json({ error: 'INVALID_AMOUNT', message: 'A positive payment amount is required.' });
      return;
    }

    try {
      const result = postDoubleEntryTransaction(db, {
        idempotencyKey: scopedKey,
        txType: 'qr_payment',
        initialStatus: 'success',
        amountPaise: finalAmountPaise,
        sourceAccountId: srcAccount.id,
        destinationAccountId: inspected.merchantAccountId,
        externalDestination: inspected.upiHandle || null,
        providerName: 'qr_sandbox',
        providerTxRef: `QR-${randomToken(6).toUpperCase()}`,
        description: inspected.note ? `QR Pay: ${inspected.note}` : `QR Payment to ${inspected.recipientName}`,
        initiatedByUserId: req.authUser!.id,
      });

      if (!result.idempotentReplay && inspected.amountPaise !== null) {
        db.prepare(`UPDATE qr_payment_tokens SET status = 'used' WHERE payload_token = ?`).run(inspected.token);
      }

      if (!result.idempotentReplay) {
        const amtText = (finalAmountPaise / 100).toFixed(2);
        const merchantOwner = db
          .prepare(
            `SELECT u.id, u.mobile, u.email, u.sms_opt_in, u.email_opt_in
             FROM accounts a JOIN users u ON u.id = a.user_id
             WHERE a.id = ?`,
          )
          .get(inspected.merchantAccountId) as
          | { id: string; mobile: string | null; email: string | null; sms_opt_in: number; email_opt_in: number }
          | undefined;

        const jobs: Array<Promise<unknown>> = [
          dispatchTransactionNotifications(db, config, {
            userId: req.authUser!.id,
            mobile: req.authUser!.mobile,
            email: req.authUser!.email,
            smsOptIn: req.authUser!.smsOptIn,
            emailOptIn: req.authUser!.emailOptIn,
            transactionId: result.transaction.id,
            subject: `QR Payment Sent: INR ${amtText} to ${inspected.recipientName} (${result.transaction.reference_code})`,
            message: `QR payment of INR ${amtText} to ${inspected.recipientName} succeeded. Ref: ${result.transaction.reference_code}.`,
          }),
        ];

        if (merchantOwner) {
          jobs.push(
            dispatchTransactionNotifications(db, config, {
              userId: merchantOwner.id,
              mobile: merchantOwner.mobile,
              email: merchantOwner.email,
              smsOptIn: merchantOwner.sms_opt_in === 1,
              emailOptIn: merchantOwner.email_opt_in === 1,
              transactionId: result.transaction.id,
              subject: `QR Payment Received: INR ${amtText} (${result.transaction.reference_code})`,
              message: `INR ${amtText} received via QR from ${req.authUser!.fullName}. Ref: ${result.transaction.reference_code}.`,
            }),
          );
        }
        await Promise.all(jobs);
      }

      res.status(result.idempotentReplay ? 200 : 201).json({
        idempotentReplay: result.idempotentReplay,
        transaction: result.transaction,
        balancePaise: getAccountBalancePaise(db, srcAccount.id),
      });
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  router.get('/notifications', requireAuth(), (req, res) => {
    const rows = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(req.authUser!.id);
    res.json({ notifications: rows });
  });

  router.post('/notifications/send-gmail', requireRole(db, 'user', 'employee', 'manager'), async (req, res) => {
    const gmailTokenHeader = req.headers['x-gmail-access-token'];
    const gmailAccessToken = typeof gmailTokenHeader === 'string' ? gmailTokenHeader.replace(/^Bearer\s+/i, '').trim() : '';

    if (!gmailAccessToken) {
      res.status(401).json({
        error: 'GMAIL_AUTH_REQUIRED',
        message: 'Sign in with Google and grant Gmail permission before sending via Gmail API.',
      });
      return;
    }

    const { transactionId, recipientEmail, confirmed } = (req.body || {}) as {
      transactionId?: string;
      recipientEmail?: string;
      confirmed?: boolean;
    };

    if (confirmed !== true) {
      res.status(400).json({
        error: 'CONFIRMATION_REQUIRED',
        message: 'Explicit user confirmation is required before sending an email via Gmail.',
      });
      return;
    }

    const targetEmail = (recipientEmail || req.authUser!.email || '').trim();
    if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      res.status(400).json({ error: 'INVALID_EMAIL', message: 'A valid recipient email address is required.' });
      return;
    }

    let subject = 'Meridian Trust Bank — Transaction Alert Test';
    let message = `Hello ${req.authUser!.fullName},\n\nThis is a verified Gmail transaction alert check from Meridian Trust Bank.`;
    let linkedTxId: string | undefined;

    if (transactionId) {
      const tx = db
        .prepare(
          `SELECT lt.*,
                  sa.account_number AS source_account_number, sa.user_id AS source_user_id,
                  da.account_number AS destination_account_number, da.user_id AS destination_user_id
           FROM ledger_transactions lt
           LEFT JOIN accounts sa ON sa.id = lt.source_account_id
           LEFT JOIN accounts da ON da.id = lt.destination_account_id
           WHERE lt.id = ? OR lt.reference_code = ?`,
        )
        .get(transactionId, transactionId) as Record<string, unknown> | undefined;

      if (!tx) {
        res.status(404).json({ error: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found.' });
        return;
      }

      if (
        req.authUser!.role === 'user' &&
        tx.source_user_id !== req.authUser!.id &&
        tx.destination_user_id !== req.authUser!.id
      ) {
        res.status(403).json({ error: 'FORBIDDEN', message: 'You are not authorized to email this transaction receipt.' });
        return;
      }

      linkedTxId = tx.id as string;
      const amtInr = ((tx.amount_paise as number) / 100).toFixed(2);
      subject = `Meridian Trust Bank Receipt: ${tx.reference_code} (INR ${amtInr})`;
      message = [
        `Meridian Trust Bank — Official Transaction Receipt`,
        `Reference: ${tx.reference_code}`,
        `Type: ${String(tx.tx_type).replace(/_/g, ' ').toUpperCase()}`,
        `Status: ${String(tx.status).toUpperCase()}`,
        `Amount: INR ${amtInr}`,
        `Description: ${tx.description}`,
        `Date: ${tx.created_at}`,
      ].join('\n');
    }

    const emailResult = await dispatchTransactionEmail(db, config, {
      userId: req.authUser!.id,
      email: targetEmail,
      emailOptIn: true,
      transactionId: linkedTxId,
      subject,
      message,
      gmailAccessToken,
    });

    if (emailResult.status === 'failed') {
      res.status(502).json({
        error: 'GMAIL_SEND_FAILED',
        message: emailResult.errorMessage || 'Unable to send email through Gmail API.',
        notification: emailResult,
      });
      return;
    }

    res.status(200).json({ ok: true, notification: emailResult });
  });

  router.get('/help/tickets', requireRole(db, 'user'), (req, res) => {
    const tickets = db
      .prepare('SELECT * FROM help_tickets WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.authUser!.id);
    res.json({ tickets });
  });

  router.post('/help/tickets', requireRole(db, 'user'), (req, res) => {
    const { category, subject, message, relatedTxRef } = (req.body || {}) as {
      category?: string;
      subject?: string;
      message?: string;
      relatedTxRef?: string;
    };

    if (!subject || !message || subject.trim().length < 3 || message.trim().length < 8) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Subject and detailed message are required.' });
      return;
    }

    const id = generateId('tkt');
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO help_tickets (id, user_id, category, subject, message, related_tx_ref, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      id,
      req.authUser!.id,
      (category || 'General Support').trim(),
      subject.trim(),
      message.trim(),
      relatedTxRef ? relatedTxRef.trim() : null,
      now,
      now,
    );

    const created = db.prepare('SELECT * FROM help_tickets WHERE id = ?').get(id);
    res.status(201).json({ ticket: created });
  });

  return router;
}
