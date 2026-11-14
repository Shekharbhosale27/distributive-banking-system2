-- 001_initial_schema.sql
-- Meridian Trust Bank initial database schema with double-entry ledger,
-- role-based identity, employee invitations, QR tokens, notifications, and audit log.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  mobile TEXT UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'employee', 'manager')),
  status TEXT NOT NULL CHECK (status IN ('active', 'pending_invite', 'deactivated', 'locked')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  sms_opt_in INTEGER NOT NULL DEFAULT 1,
  email_opt_in INTEGER NOT NULL DEFAULT 1,
  kyc_status TEXT NOT NULL DEFAULT 'verified' CHECK (kyc_status IN ('unverified', 'pending', 'verified', 'rejected')),
  kyc_provider_ref TEXT,
  kyc_masked_id TEXT,
  department TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS employee_invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  mobile TEXT NOT NULL,
  full_name TEXT NOT NULL,
  department TEXT NOT NULL,
  invite_token_hash TEXT UNIQUE NOT NULL,
  email_code_hash TEXT NOT NULL,
  mobile_code_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  mobile_verified INTEGER NOT NULL DEFAULT 0,
  invited_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at TEXT NOT NULL,
  accepted_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_employee_invites_email ON employee_invites(email);

CREATE TABLE IF NOT EXISTS password_recovery_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_number TEXT UNIQUE NOT NULL,
  user_id TEXT REFERENCES users(id),
  account_type TEXT NOT NULL CHECK (account_type IN ('checking', 'savings', 'system_vault', 'system_clearing')),
  currency TEXT NOT NULL DEFAULT 'INR',
  upi_handle TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
  daily_transfer_limit_paise INTEGER NOT NULL DEFAULT 10000000,
  per_tx_limit_paise INTEGER NOT NULL DEFAULT 5000000,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_account_number ON accounts(account_number);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id TEXT PRIMARY KEY,
  reference_code TEXT UNIQUE NOT NULL,
  idempotency_key TEXT UNIQUE,
  tx_type TEXT NOT NULL CHECK (
    tx_type IN (
      'internal_transfer',
      'upi_transfer',
      'mobile_transfer',
      'qr_payment',
      'bank_transfer',
      'employee_credit',
      'employee_debit',
      'reversal',
      'opening_deposit'
    )
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'reversed')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  source_account_id TEXT REFERENCES accounts(id),
  destination_account_id TEXT REFERENCES accounts(id),
  external_destination TEXT,
  provider_name TEXT NOT NULL,
  provider_tx_ref TEXT,
  description TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL REFERENCES users(id),
  reversed_transaction_id TEXT REFERENCES ledger_transactions(id),
  failure_reason TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ledger_tx_source ON ledger_transactions(source_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_dest ON ledger_transactions(destination_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_created ON ledger_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_status ON ledger_transactions(status);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('debit', 'credit')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_tx ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);

CREATE TABLE IF NOT EXISTS qr_payment_tokens (
  id TEXT PRIMARY KEY,
  payload_token TEXT UNIQUE NOT NULL,
  merchant_account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_paise INTEGER CHECK (amount_paise IS NULL OR amount_paise > 0),
  note TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'used', 'expired')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  transaction_id TEXT REFERENCES ledger_transactions(id),
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'in_app', 'email')),
  recipient_masked TEXT NOT NULL,
  message TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped_opt_out', 'sandbox_logged')),
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS help_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  related_tx_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'in_review', 'resolved')),
  assigned_employee_id TEXT REFERENCES users(id),
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
