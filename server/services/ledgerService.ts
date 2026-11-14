import type Database from 'better-sqlite3';
import { SYSTEM_CLEARING_ACCOUNT_ID, SYSTEM_VAULT_ACCOUNT_ID } from '../db/database.ts';
import { generateId, generateReferenceCode } from '../security/crypto.ts';

export class LedgerError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface LedgerTransactionRow {
  id: string;
  reference_code: string;
  idempotency_key: string | null;
  tx_type: string;
  status: 'pending' | 'success' | 'failed' | 'reversed';
  amount_paise: number;
  currency: string;
  source_account_id: string | null;
  destination_account_id: string | null;
  external_destination: string | null;
  provider_name: string;
  provider_tx_ref: string | null;
  description: string;
  initiated_by_user_id: string;
  reversed_transaction_id: string | null;
  failure_reason: string | null;
  metadata_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export function getAccountBalancePaise(db: Database.Database, accountId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN amount_paise ELSE -amount_paise END), 0) AS balance_paise
       FROM ledger_entries
       WHERE account_id = ?`,
    )
    .get(accountId) as { balance_paise: number };
  return row.balance_paise;
}

export function getDailyOutboundPaise(db: Database.Database, accountId: string): number {
  const utcMidnight = new Date();
  utcMidnight.setUTCHours(0, 0, 0, 0);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_paise), 0) AS total_paise
       FROM ledger_transactions
       WHERE source_account_id = ?
         AND status IN ('pending', 'success')
         AND tx_type IN ('internal_transfer', 'upi_transfer', 'mobile_transfer', 'qr_payment', 'bank_transfer')
         AND created_at >= ?`,
    )
    .get(accountId, utcMidnight.toISOString()) as { total_paise: number };
  return row.total_paise;
}

export interface PostTransferParams {
  idempotencyKey: string;
  txType:
    | 'internal_transfer'
    | 'upi_transfer'
    | 'mobile_transfer'
    | 'qr_payment'
    | 'bank_transfer'
    | 'employee_credit'
    | 'employee_debit'
    | 'opening_deposit';
  initialStatus: 'pending' | 'success' | 'failed';
  amountPaise: number;
  sourceAccountId: string;
  destinationAccountId: string;
  externalDestination?: string | null;
  providerName: string;
  providerTxRef?: string | null;
  description: string;
  initiatedByUserId: string;
  failureReason?: string | null;
  metadata?: Record<string, unknown>;
  enforceCustomerLimits?: boolean;
}

export interface PostTransferResult {
  idempotentReplay: boolean;
  transaction: LedgerTransactionRow;
}

export function postDoubleEntryTransaction(
  db: Database.Database,
  params: PostTransferParams,
): PostTransferResult {
  if (!Number.isInteger(params.amountPaise) || params.amountPaise <= 0) {
    throw new LedgerError('INVALID_AMOUNT', 'Amount must be a positive integer in minor units.', 400);
  }
  if (params.sourceAccountId === params.destinationAccountId) {
    throw new LedgerError('SAME_ACCOUNT', 'Source and destination accounts cannot be identical.', 400);
  }

  const exec = db.transaction((): PostTransferResult => {
    const existing = db
      .prepare('SELECT * FROM ledger_transactions WHERE idempotency_key = ?')
      .get(params.idempotencyKey) as LedgerTransactionRow | undefined;

    if (existing) {
      return { idempotentReplay: true, transaction: existing };
    }

    const srcAccount = db
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(params.sourceAccountId) as
      | {
          id: string;
          account_type: string;
          status: string;
          daily_transfer_limit_paise: number;
          per_tx_limit_paise: number;
        }
      | undefined;

    const dstAccount = db
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(params.destinationAccountId) as { id: string; status: string } | undefined;

    if (!srcAccount || srcAccount.status !== 'active') {
      throw new LedgerError('INVALID_SOURCE_ACCOUNT', 'Source account is not active.', 400);
    }
    if (!dstAccount || dstAccount.status !== 'active') {
      throw new LedgerError('INVALID_DESTINATION_ACCOUNT', 'Destination account is not active.', 400);
    }

    const isCustomerSource = srcAccount.account_type === 'checking' || srcAccount.account_type === 'savings';

    if (isCustomerSource && params.initialStatus !== 'failed') {
      if (params.enforceCustomerLimits !== false) {
        if (params.amountPaise > srcAccount.per_tx_limit_paise) {
          throw new LedgerError(
            'PER_TX_LIMIT_EXCEEDED',
            `Amount exceeds per-transaction limit of INR ${(srcAccount.per_tx_limit_paise / 100).toFixed(2)}.`,
            400,
          );
        }
        const usedToday = getDailyOutboundPaise(db, srcAccount.id);
        if (usedToday + params.amountPaise > srcAccount.daily_transfer_limit_paise) {
          throw new LedgerError(
            'DAILY_LIMIT_EXCEEDED',
            `Transfer would exceed daily limit of INR ${(srcAccount.daily_transfer_limit_paise / 100).toFixed(2)}.`,
            400,
          );
        }
      }

      const balance = getAccountBalancePaise(db, srcAccount.id);
      if (balance < params.amountPaise) {
        throw new LedgerError('INSUFFICIENT_FUNDS', 'Insufficient available balance for this transaction.', 400);
      }
    }

    const now = new Date().toISOString();
    const txId = generateId('tx');
    const refCode = generateReferenceCode('TXN');
    const completedAt = params.initialStatus === 'pending' ? null : now;

    db.prepare(`
      INSERT INTO ledger_transactions (
        id, reference_code, idempotency_key, tx_type, status, amount_paise, currency,
        source_account_id, destination_account_id, external_destination, provider_name,
        provider_tx_ref, description, initiated_by_user_id, failure_reason, metadata_json,
        created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      txId,
      refCode,
      params.idempotencyKey,
      params.txType,
      params.initialStatus,
      params.amountPaise,
      params.sourceAccountId,
      params.destinationAccountId,
      params.externalDestination ?? null,
      params.providerName,
      params.providerTxRef ?? null,
      params.description,
      params.initiatedByUserId,
      params.failureReason ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      now,
      completedAt,
    );

    // For failed transactions recorded at submission, no funds move (0 ledger entries);
    // for pending (held) and success (posted), record strictly balanced debit + credit entries.
    if (params.initialStatus !== 'failed') {
      const insertEntry = db.prepare(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount_paise, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertEntry.run(generateId('le'), txId, params.sourceAccountId, 'debit', params.amountPaise, now);
      insertEntry.run(generateId('le'), txId, params.destinationAccountId, 'credit', params.amountPaise, now);

      const check = db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN entry_type='debit' THEN amount_paise ELSE 0 END), 0) AS debits,
             COALESCE(SUM(CASE WHEN entry_type='credit' THEN amount_paise ELSE 0 END), 0) AS credits
           FROM ledger_entries WHERE transaction_id = ?`,
        )
        .get(txId) as { debits: number; credits: number };

      if (check.debits !== check.credits) {
        throw new LedgerError('LEDGER_IMBALANCE', 'Double-entry invariant violated.', 500);
      }
    }

    const created = db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(txId) as LedgerTransactionRow;
    return { idempotentReplay: false, transaction: created };
  }).immediate();

  return exec;
}

export function settlePendingTransaction(
  db: Database.Database,
  txId: string,
  outcome: 'success' | 'failed',
  actorUserId: string,
  reason?: string,
): { original: LedgerTransactionRow; reversal?: LedgerTransactionRow } {
  return db.transaction(() => {
    const tx = db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(txId) as LedgerTransactionRow | undefined;
    if (!tx) throw new LedgerError('NOT_FOUND', 'Transaction not found.', 404);
    if (tx.status !== 'pending') {
      return { original: tx };
    }

    const now = new Date().toISOString();
    if (outcome === 'success') {
      db.prepare(`UPDATE ledger_transactions SET status = 'success', completed_at = ? WHERE id = ?`).run(now, tx.id);
      const updated = db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(tx.id) as LedgerTransactionRow;
      return { original: updated };
    }

    // Outcome is failed: mark original failed and post compensating reversal entry from destination (clearing) back to source
    db.prepare(`UPDATE ledger_transactions SET status = 'failed', failure_reason = ?, completed_at = ? WHERE id = ?`).run(
      reason || 'External provider declined or timed out.',
      now,
      tx.id,
    );

    const revId = generateId('tx');
    const revRef = generateReferenceCode('REV');
    db.prepare(`
      INSERT INTO ledger_transactions (
        id, reference_code, idempotency_key, tx_type, status, amount_paise, currency,
        source_account_id, destination_account_id, provider_name, description,
        initiated_by_user_id, reversed_transaction_id, created_at, completed_at
      ) VALUES (?, ?, ?, 'reversal', 'success', ?, 'INR', ?, ?, 'internal', ?, ?, ?, ?, ?)
    `).run(
      revId,
      revRef,
      `fail_refund_${tx.id}`,
      tx.amount_paise,
      tx.destination_account_id,
      tx.source_account_id,
      `Automatic refund for failed ${tx.reference_code}: ${reason || 'Provider failure'}`,
      actorUserId,
      tx.id,
      now,
      now,
    );

    const insertEntry = db.prepare(`
      INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount_paise, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertEntry.run(generateId('le'), revId, tx.destination_account_id, 'debit', tx.amount_paise, now);
    insertEntry.run(generateId('le'), revId, tx.source_account_id, 'credit', tx.amount_paise, now);

    const updated = db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(tx.id) as LedgerTransactionRow;
    const revRow = db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(revId) as LedgerTransactionRow;
    return { original: updated, reversal: revRow };
  }).immediate();
}

export function reverseSettledTransaction(
  db: Database.Database,
  txId: string,
  actorUserId: string,
  reason: string,
): { original: LedgerTransactionRow; reversal: LedgerTransactionRow } {
  if (!reason || reason.trim().length < 4) {
    throw new LedgerError('REASON_REQUIRED', 'A reversal reason of at least 4 characters is required.', 400);
  }

  return db.transaction(() => {
    const tx = db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(txId) as LedgerTransactionRow | undefined;
    if (!tx) throw new LedgerError('NOT_FOUND', 'Transaction not found.', 404);
    if (tx.status !== 'success') {
      throw new LedgerError('CANNOT_REVERSE', `Only settled ('success') transactions can be reversed. Current status: ${tx.status}.`, 400);
    }
    if (tx.tx_type === 'reversal') {
      throw new LedgerError('CANNOT_REVERSE', 'A reversal transaction cannot be reversed again.', 400);
    }
    if (!tx.source_account_id || !tx.destination_account_id) {
      throw new LedgerError('CANNOT_REVERSE', 'Transaction accounts missing.', 400);
    }

    // Check destination account balance if it is a customer account (to avoid negative customer balance without authorization)
    const dstAccount = db.prepare('SELECT account_type FROM accounts WHERE id = ?').get(tx.destination_account_id) as
      | { account_type: string }
      | undefined;

    if (dstAccount && (dstAccount.account_type === 'checking' || dstAccount.account_type === 'savings')) {
      const dstBalance = getAccountBalancePaise(db, tx.destination_account_id);
      if (dstBalance < tx.amount_paise) {
        throw new LedgerError('DESTINATION_INSUFFICIENT_FUNDS', 'Recipient account lacks sufficient balance to execute reversal.', 400);
      }
    }

    const now = new Date().toISOString();
    const revId = generateId('tx');
    const revRef = generateReferenceCode('REV');

    db.prepare(`UPDATE ledger_transactions SET status = 'reversed' WHERE id = ?`).run(tx.id);

    db.prepare(`
      INSERT INTO ledger_transactions (
        id, reference_code, idempotency_key, tx_type, status, amount_paise, currency,
        source_account_id, destination_account_id, provider_name, description,
        initiated_by_user_id, reversed_transaction_id, created_at, completed_at
      ) VALUES (?, ?, ?, 'reversal', 'success', ?, 'INR', ?, ?, 'internal', ?, ?, ?, ?, ?)
    `).run(
      revId,
      revRef,
      `reversal_${tx.id}`,
      tx.amount_paise,
      tx.destination_account_id,
      tx.source_account_id,
      `Reversal of ${tx.reference_code}: ${reason.trim()}`,
      actorUserId,
      tx.id,
      now,
      now,
    );

    const insertEntry = db.prepare(`
      INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount_paise, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertEntry.run(generateId('le'), revId, tx.destination_account_id, 'debit', tx.amount_paise, now);
    insertEntry.run(generateId('le'), revId, tx.source_account_id, 'credit', tx.amount_paise, now);

    const updated = db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(tx.id) as LedgerTransactionRow;
    const revRow = db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(revId) as LedgerTransactionRow;
    return { original: updated, reversal: revRow };
  }).immediate();
}

export function verifyLedgerZeroSum(db: Database.Database): {
  totalDebitsPaise: number;
  totalCreditsPaise: number;
  customerBalancesPaise: number;
  systemVaultBalancePaise: number;
  systemClearingBalancePaise: number;
  balanced: boolean;
} {
  const sums = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN entry_type = 'debit' THEN amount_paise ELSE 0 END), 0) AS total_debits,
         COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN amount_paise ELSE 0 END), 0) AS total_credits
       FROM ledger_entries`,
    )
    .get() as { total_debits: number; total_credits: number };

  const custSum = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount_paise ELSE -le.amount_paise END), 0) AS bal
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       WHERE a.account_type IN ('checking', 'savings')`,
    )
    .get() as { bal: number };

  const vaultBal = getAccountBalancePaise(db, SYSTEM_VAULT_ACCOUNT_ID);
  const clearingBal = getAccountBalancePaise(db, SYSTEM_CLEARING_ACCOUNT_ID);

  return {
    totalDebitsPaise: sums.total_debits,
    totalCreditsPaise: sums.total_credits,
    customerBalancesPaise: custSum.bal,
    systemVaultBalancePaise: vaultBal,
    systemClearingBalancePaise: clearingBal,
    balanced:
      sums.total_debits === sums.total_credits &&
      custSum.bal + vaultBal + clearingBal === 0,
  };
}
