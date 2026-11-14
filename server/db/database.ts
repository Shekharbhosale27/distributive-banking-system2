import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AppConfig } from '../config.ts';
import { generateId, generateReferenceCode, hashPassword } from '../security/crypto.ts';

export const SYSTEM_VAULT_ACCOUNT_ID = 'acct_sys_vault_0001';
export const SYSTEM_CLEARING_ACCOUNT_ID = 'acct_sys_clearing_0001';
export const MAX_USER_ACCOUNTS = 20;
export const MAX_EMPLOYEE_ACCOUNTS = 5;

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function runMigrations(db: Database.Database, migrationsDir = path.resolve(process.cwd(), 'migrations')): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const checkStmt = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const markStmt = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (checkStmt.get(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const applyTx = db.transaction(() => {
      db.exec(sql);
      markStmt.run(file, new Date().toISOString());
    });
    applyTx();
    applied.push(file);
  }

  return applied;
}

function ensureSystemAccounts(db: Database.Database): void {
  const now = new Date().toISOString();
  const insertAcct = db.prepare(`
    INSERT OR IGNORE INTO accounts (
      id, account_number, user_id, account_type, currency, upi_handle, status,
      daily_transfer_limit_paise, per_tx_limit_paise, created_at
    ) VALUES (?, ?, NULL, ?, 'INR', NULL, 'active', 999999999999, 999999999999, ?)
  `);
  insertAcct.run(SYSTEM_VAULT_ACCOUNT_ID, 'SYS-VAULT-0001', 'system_vault', now);
  insertAcct.run(SYSTEM_CLEARING_ACCOUNT_ID, 'SYS-CLEARING-0001', 'system_clearing', now);
}

export function seedDatabase(db: Database.Database, config: AppConfig): void {
  ensureSystemAccounts(db);

  const existingManager = db.prepare(`SELECT id FROM users WHERE role = 'manager' LIMIT 1`).get();

  if (config.isProduction) {
    // Production NEVER seeds manager/1234 or sample users
    if (!existingManager && config.bootstrapManagerUsername && config.bootstrapManagerPassword) {
      if (config.bootstrapManagerPassword.length < 12) {
        throw new Error('BOOTSTRAP_MANAGER_PASSWORD must be at least 12 characters in production.');
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO users (
          id, username, email, mobile, full_name, password_hash, role, status,
          must_change_password, kyc_status, department, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'manager', 'active', 1, 'verified', 'Executive Governance', ?, ?)
      `).run(
        generateId('usr'),
        config.bootstrapManagerUsername,
        null,
        null,
        'Initial Branch Manager',
        hashPassword(config.bootstrapManagerPassword),
        now,
        now,
      );
    }
    return;
  }

  if (!config.allowDevSeed) {
    return;
  }

  // Only seed baseline sample development data if database has no users yet
  const userCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;
  if (userCount > 0) {
    return;
  }

  const now = new Date().toISOString();
  const insertUser = db.prepare(`
    INSERT INTO users (
      id, username, email, mobile, full_name, password_hash, role, status,
      must_change_password, sms_opt_in, email_opt_in, kyc_status, kyc_provider_ref, kyc_masked_id,
      department, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, 1, 'verified', ?, ?, ?, ?, ?)
  `);

  const managerId = 'usr_dev_manager_001';
  const emp1Id = 'usr_dev_emp_001';
  const emp2Id = 'usr_dev_emp_002';
  const cust1Id = 'usr_dev_cust_001';
  const cust2Id = 'usr_dev_cust_002';
  const cust3Id = 'usr_dev_cust_003';

  // Local dev manager account with required first-login password change
  insertUser.run(
    managerId,
    'manager',
    'arjun.deshmukh@meridianbank.example',
    '+919000000001',
    'Arjun Deshmukh',
    hashPassword('1234'),
    'manager',
    1,
    'KYC-DEV-MGR1',
    'XXXX-XXXX-9001',
    'Executive Governance',
    now,
    now,
  );

  insertUser.run(
    emp1Id,
    'teller.priya',
    'priya.nair@meridianbank.example',
    '+919000000002',
    'Priya Nair',
    hashPassword('BankStaff#2026'),
    'employee',
    0,
    'KYC-DEV-EMP1',
    'XXXX-XXXX-9002',
    'Retail Operations',
    now,
    now,
  );

  insertUser.run(
    emp2Id,
    'teller.rohan',
    'rohan.kulkarni@meridianbank.example',
    '+919000000003',
    'Rohan Kulkarni',
    hashPassword('BankStaff#2026'),
    'employee',
    0,
    'KYC-DEV-EMP2',
    'XXXX-XXXX-9003',
    'KYC & Onboarding',
    now,
    now,
  );

  insertUser.run(
    cust1Id,
    'aarav.sharma',
    'aarav.sharma@example.com',
    '+919800001001',
    'Aarav Sharma',
    hashPassword('Customer#2026'),
    'user',
    0,
    'KYC-DEV-1001',
    'XXXX-XXXX-4101',
    null,
    now,
    now,
  );

  insertUser.run(
    cust2Id,
    'meera.iyer',
    'meera.iyer@example.com',
    '+919800001002',
    'Meera Iyer',
    hashPassword('Customer#2026'),
    'user',
    0,
    'KYC-DEV-1002',
    'XXXX-XXXX-4102',
    null,
    now,
    now,
  );

  insertUser.run(
    cust3Id,
    'kabir.verma',
    'kabir.verma@example.com',
    '+919800001003',
    'Kabir Verma',
    hashPassword('Customer#2026'),
    'user',
    0,
    'KYC-DEV-1003',
    'XXXX-XXXX-4103',
    null,
    now,
    now,
  );

  const insertAccount = db.prepare(`
    INSERT INTO accounts (
      id, account_number, user_id, account_type, currency, upi_handle, status,
      daily_transfer_limit_paise, per_tx_limit_paise, created_at
    ) VALUES (?, ?, ?, ?, 'INR', ?, 'active', 10000000, 5000000, ?)
  `);

  const acct1Id = 'acct_dev_001';
  const acct2Id = 'acct_dev_002';
  const acct3Id = 'acct_dev_003';

  insertAccount.run(acct1Id, 'MTB00100001', cust1Id, 'checking', 'aarav@meridian', now);
  insertAccount.run(acct2Id, 'MTB00100002', cust2Id, 'savings', 'meera@meridian', now);
  insertAccount.run(acct3Id, 'MTB00100003', cust3Id, 'checking', 'kabir@meridian', now);

  // Seed balanced double-entry transactions
  const seedTx = (
    txType: string,
    status: string,
    amountPaise: number,
    srcAcct: string,
    dstAcct: string,
    providerName: string,
    description: string,
    initiatorId: string,
    extDest: string | null,
    hoursAgo: number,
  ) => {
    const txId = generateId('tx');
    const createdAt = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
    const completedAt = status === 'pending' ? null : createdAt;

    db.prepare(`
      INSERT INTO ledger_transactions (
        id, reference_code, idempotency_key, tx_type, status, amount_paise, currency,
        source_account_id, destination_account_id, external_destination, provider_name,
        provider_tx_ref, description, initiated_by_user_id, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      txId,
      generateReferenceCode('TXN'),
      `seed_${txId}`,
      txType,
      status,
      amountPaise,
      srcAcct,
      dstAcct,
      extDest,
      providerName,
      `SEED-${txId.slice(0, 8)}`,
      description,
      initiatorId,
      createdAt,
      completedAt,
    );

    const insertEntry = db.prepare(`
      INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount_paise, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertEntry.run(generateId('le'), txId, srcAcct, 'debit', amountPaise, createdAt);
    insertEntry.run(generateId('le'), txId, dstAcct, 'credit', amountPaise, createdAt);
    return txId;
  };

  // Opening deposits from system vault
  seedTx('opening_deposit', 'success', 5_000_000, SYSTEM_VAULT_ACCOUNT_ID, acct1Id, 'internal', 'Initial account funding', emp1Id, null, 72);
  seedTx('opening_deposit', 'success', 3_000_000, SYSTEM_VAULT_ACCOUNT_ID, acct2Id, 'internal', 'Initial account funding', emp1Id, null, 68);
  seedTx('opening_deposit', 'success', 1_800_000, SYSTEM_VAULT_ACCOUNT_ID, acct3Id, 'internal', 'Initial account funding', emp2Id, null, 48);

  // Internal & QR activity
  const tx1 = seedTx('internal_transfer', 'success', 250_000, acct1Id, acct2Id, 'internal', 'Monthly shared studio rent', cust1Id, null, 24);
  seedTx('qr_payment', 'success', 75_000, acct3Id, acct1Id, 'qr_sandbox', 'Design consultation invoice #104', cust3Id, 'aarav@meridian', 12);
  seedTx('bank_transfer', 'pending', 150_000, acct3Id, SYSTEM_CLEARING_ACCOUNT_ID, 'bank_rails_sandbox', 'NEFT to Meridian Supplier Partner', cust3Id, 'HDFC••••8821 (NEFT)', 3);

  // Sample notification & help ticket
  db.prepare(`
    INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, provider_message_id, status, created_at)
    VALUES (?, ?, ?, 'sms', '+91****1001', 'INR 2,500.00 debited from MTB••••0001 for Monthly shared studio rent.', 'sms_sandbox', 'SMS-SBX-SEED1', 'sandbox_logged', ?)
  `).run(generateId('notif'), cust1Id, tx1, now);

  db.prepare(`
    INSERT INTO help_tickets (id, user_id, category, subject, message, related_tx_ref, status, created_at, updated_at)
    VALUES (?, ?, 'Transfer Inquiry', 'NEFT settlement timeline question', 'Could you confirm the expected settlement window for my pending NEFT payment?', NULL, 'open', ?, ?)
  `).run(generateId('tkt'), cust3Id, now, now);

  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, actor_role, action, target_type, target_id, details_json, ip_address, created_at)
    VALUES (?, ?, 'manager', 'DEV_DATABASE_SEEDED', 'system', 'initial', ?, '127.0.0.1', ?)
  `).run(generateId('aud'), managerId, JSON.stringify({ environment: config.nodeEnv, seededUsers: 6 }), now);
}
