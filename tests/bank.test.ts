import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { loadConfig } from '../server/config.ts';
import { openDatabase, runMigrations, seedDatabase } from '../server/db/database.ts';
import { createBankApp } from '../server/app.ts';
import { verifyLedgerZeroSum } from '../server/services/ledgerService.ts';
import { computeVerhoeffCheckDigit } from '../server/providers/kycProvider.ts';
import { signHmac } from '../server/security/crypto.ts';

function setupTestEnv(isProduction = false) {
  const config = loadConfig({
    nodeEnv: isProduction ? 'production' : 'development',
    isProduction,
    allowDevSeed: !isProduction,
    dbPath: ':memory:',
    employeeMaxAdjustmentPaise: 2_500_000, // INR 25,000
    paymentWebhookSecret: 'test-webhook-secret',
  });
  const db = openDatabase(':memory:');
  runMigrations(db);
  seedDatabase(db, config);
  const app = createBankApp({ db, config });
  return { db, config, app };
}

async function loginAgent(app: ReturnType<typeof createBankApp>, username: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  return { agent, res, csrfToken: res.body.csrfToken as string };
}

describe('Meridian Trust Bank — Security, RBAC, Ledger & Payments', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createBankApp>;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(() => {
    const env = setupTestEnv(false);
    db = env.db;
    app = env.app;
    config = env.config;
  });

  it('requires password change on first login for seeded dev manager and never seeds 1234 in production', async () => {
    const { agent, res, csrfToken } = await loginAgent(app, 'manager', '1234');
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);

    // Blocked until password is changed
    const blocked = await agent.get('/api/manager/overview');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('PASSWORD_CHANGE_REQUIRED');

    // Change password
    const changed = await agent
      .post('/api/auth/change-password')
      .set('X-CSRF-Token', csrfToken)
      .send({ currentPassword: '1234', newPassword: 'ManagerSecure#2026' });
    expect(changed.status).toBe(200);

    // Now manager overview works
    const allowed = await agent.get('/api/manager/overview');
    expect(allowed.status).toBe(200);
    expect(allowed.body.aggregates.ledgerBalanced).toBe(true);

    // Production environment must NOT seed manager/1234
    const prod = setupTestEnv(true);
    const prodLogin = await request(prod.app).post('/api/auth/login').send({ username: 'manager', password: '1234' });
    expect(prodLogin.status).toBe(401);
  });

  it('locks account after 5 failed login attempts and enforces CSRF on cookie mutations', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await request(app).post('/api/auth/login').send({ username: 'aarav.sharma', password: 'wrong' });
      expect(r.status).toBe(401);
    }
    const fifth = await request(app).post('/api/auth/login').send({ username: 'aarav.sharma', password: 'wrong' });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error).toBe('ACCOUNT_LOCKED');

    // Even valid password is blocked while locked
    const validWhileLocked = await request(app)
      .post('/api/auth/login')
      .send({ username: 'aarav.sharma', password: 'Customer#2026' });
    expect(validWhileLocked.status).toBe(423);

    // CSRF enforcement check for active user
    const { agent } = await loginAgent(app, 'meera.iyer', 'Customer#2026');
    const missingCsrf = await agent
      .post('/api/transfers/internal')
      .send({ destinationAccountNumber: 'MTB00100003', amountPaise: 10000, idempotencyKey: 'csrf-test-1' });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error).toBe('CSRF_VALIDATION_FAILED');
  });

  it('strictly enforces role-based access control across user, employee, and manager endpoints', async () => {
    const userSession = await loginAgent(app, 'aarav.sharma', 'Customer#2026');
    expect((await userSession.agent.get('/api/employee/customers')).status).toBe(403);
    expect((await userSession.agent.get('/api/manager/overview')).status).toBe(403);

    const empSession = await loginAgent(app, 'teller.priya', 'BankStaff#2026');
    expect((await empSession.agent.get('/api/accounts/me')).status).toBe(403);
    expect((await empSession.agent.get('/api/manager/audit-logs')).status).toBe(403);
    expect(
      (
        await empSession.agent
          .post('/api/manager/employees/invite')
          .set('X-CSRF-Token', empSession.csrfToken)
          .send({ fullName: 'X', email: 'x@gmail.com', mobile: '+919900001111', department: 'Ops' })
      ).status,
    ).toBe(403);

    // Change manager password first
    const mgr = await loginAgent(app, 'manager', '1234');
    await mgr.agent
      .post('/api/auth/change-password')
      .set('X-CSRF-Token', mgr.csrfToken)
      .send({ currentPassword: '1234', newPassword: 'ManagerSecure#2026' });

    // Manager customer directory must omit password hashes and raw KYC
    const mgrCustomers = await mgr.agent.get('/api/manager/customers');
    expect(mgrCustomers.status).toBe(200);
    const serialized = JSON.stringify(mgrCustomers.body);
    expect(serialized).not.toContain('password_hash');
    expect(serialized).not.toContain('kyc_provider_ref');
  });

  it('maintains double-entry zero-sum ledger, idempotency, insufficient funds, and transfer limits', async () => {
    const { agent, csrfToken } = await loginAgent(app, 'aarav.sharma', 'Customer#2026');
    const balBefore = (await agent.get('/api/balances/me')).body.balancePaise;

    // Duplicate idempotencyKey must only debit once
    const payload = {
      destinationAccountNumber: 'MTB00100002',
      amountPaise: 50000, // INR 500.00
      description: 'Shared dinner',
      idempotencyKey: 'idem-key-100',
    };
    const first = await agent.post('/api/transfers/internal').set('X-CSRF-Token', csrfToken).send(payload);
    expect(first.status).toBe(201);
    expect(first.body.idempotentReplay).toBe(false);

    const second = await agent.post('/api/transfers/internal').set('X-CSRF-Token', csrfToken).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.idempotentReplay).toBe(true);

    const balAfter = (await agent.get('/api/balances/me')).body.balancePaise;
    expect(balAfter).toBe(balBefore - 50000);

    // Per-transaction limit exceeded (> 5,000,000 paise = INR 50,000)
    const overLimit = await agent.post('/api/transfers/internal').set('X-CSRF-Token', csrfToken).send({
      destinationAccountNumber: 'MTB00100002',
      amountPaise: 6_000_000,
      idempotencyKey: 'limit-test-1',
    });
    expect(overLimit.status).toBe(400);
    expect(overLimit.body.error).toBe('PER_TX_LIMIT_EXCEEDED');

    // Insufficient funds (send 3,000,000 twice -> 1st succeeds leaving 1,700,000, 2nd fails INSUFFICIENT_FUNDS)
    const ok1 = await agent.post('/api/transfers/internal').set('X-CSRF-Token', csrfToken).send({
      destinationAccountNumber: 'MTB00100002',
      amountPaise: 3_000_000,
      idempotencyKey: 'insuff-1',
    });
    expect(ok1.status).toBe(201);

    const fail2 = await agent.post('/api/transfers/internal').set('X-CSRF-Token', csrfToken).send({
      destinationAccountNumber: 'MTB00100002',
      amountPaise: 3_000_000,
      idempotencyKey: 'insuff-2',
    });
    expect(fail2.status).toBe(400);
    expect(fail2.body.error).toBe('INSUFFICIENT_FUNDS');

    expect(verifyLedgerZeroSum(db).balanced).toBe(true);
  });

  it('validates mobile resolution, QR inspect-before-pay, pending bank transfer webhook failure, and SMS failure isolation', async () => {
    const aarav = await loginAgent(app, 'aarav.sharma', 'Customer#2026');
    const meera = await loginAgent(app, 'meera.iyer', 'Customer#2026');

    // Unregistered mobile must NOT be assumed to be a UPI address
    const badMobile = await aarav.agent
      .post('/api/transfers/resolve-mobile')
      .set('X-CSRF-Token', aarav.csrfToken)
      .send({ mobile: '+919999999999' });
    expect(badMobile.status).toBe(404);
    expect(badMobile.body.error).toBe('MOBILE_NOT_RESOLVED');

    // Registered mobile resolves cleanly
    const goodMobile = await aarav.agent
      .post('/api/transfers/resolve-mobile')
      .set('X-CSRF-Token', aarav.csrfToken)
      .send({ mobile: '+919800001002' });
    expect(goodMobile.status).toBe(200);
    expect(goodMobile.body.upiHandle).toBe('meera@meridian');

    // QR generate -> inspect (does NOT pay) -> pay (requires confirmed: true)
    const qrRes = await meera.agent
      .post('/api/qr/generate')
      .set('X-CSRF-Token', meera.csrfToken)
      .send({ amountPaise: 12000, note: 'Coffee split' });
    expect(qrRes.status).toBe(201);

    const aaravBeforeQr = (await aarav.agent.get('/api/balances/me')).body.balancePaise;
    const inspectRes = await aarav.agent
      .post('/api/qr/inspect')
      .set('X-CSRF-Token', aarav.csrfToken)
      .send({ payload: qrRes.body.payloadString });
    expect(inspectRes.status).toBe(200);
    expect(inspectRes.body.recipientName).toBe('Meera Iyer');
    expect(inspectRes.body.amountPaise).toBe(12000);
    expect((await aarav.agent.get('/api/balances/me')).body.balancePaise).toBe(aaravBeforeQr);

    // Unconfirmed QR pay rejected
    const unconfirmedQr = await aarav.agent
      .post('/api/qr/pay')
      .set('X-CSRF-Token', aarav.csrfToken)
      .send({ payload: qrRes.body.payloadString, confirmed: false, idempotencyKey: 'qr-unconf' });
    expect(unconfirmedQr.status).toBe(400);

    // Confirmed QR pay succeeds
    const confirmedQr = await aarav.agent
      .post('/api/qr/pay')
      .set('X-CSRF-Token', aarav.csrfToken)
      .send({ payload: qrRes.body.payloadString, confirmed: true, idempotencyKey: 'qr-conf-1' });
    expect(confirmedQr.status).toBe(201);
    expect((await aarav.agent.get('/api/balances/me')).body.balancePaise).toBe(aaravBeforeQr - 12000);

    // Bank transfer rejects forbidden password/pin fields
    const pinRejected = await aarav.agent
      .post('/api/transfers/bank')
      .set('X-CSRF-Token', aarav.csrfToken)
      .send({
        beneficiaryName: 'Vendor',
        accountNumber: '1234567890',
        ifscCode: 'HDFC0001234',
        amountPaise: 50000,
        pin: '1234',
        idempotencyKey: 'bank-pin-1',
      });
    expect(pinRejected.status).toBe(400);
    expect(pinRejected.body.error).toBe('FORBIDDEN_FIELD');

    // Valid bank transfer starts pending, then webhook marks failed & refunds atomically
    const balBeforeBank = (await aarav.agent.get('/api/balances/me')).body.balancePaise;
    const bankRes = await aarav.agent
      .post('/api/transfers/bank')
      .set('X-CSRF-Token', aarav.csrfToken)
      .send({
        beneficiaryName: 'Supplier Ltd',
        accountNumber: '987654321012',
        ifscCode: 'HDFC0001234',
        rail: 'NEFT',
        amountPaise: 100000,
        idempotencyKey: 'bank-neft-1',
      });
    expect(bankRes.status).toBe(201);
    expect(bankRes.body.transaction.status).toBe('pending');
    expect((await aarav.agent.get('/api/balances/me')).body.balancePaise).toBe(balBeforeBank - 100000);

    const webhookBody = {
      transactionId: bankRes.body.transaction.id,
      outcome: 'failed',
      reason: 'Beneficiary account closed',
    };
    const sig = signHmac(JSON.stringify(webhookBody), config.paymentWebhookSecret);
    const webhookRes = await request(app)
      .post('/api/webhooks/payment-provider')
      .set('X-Webhook-Signature', sig)
      .send(webhookBody);
    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.transaction.status).toBe('failed');

    // Funds automatically refunded & ledger balanced
    expect((await aarav.agent.get('/api/balances/me')).body.balancePaise).toBe(balBeforeBank);
    expect(verifyLedgerZeroSum(db).balanced).toBe(true);
  });

  it('supports Aadhaar KYC onboarding without storing raw Aadhaar, employee adjustment limits, and manager employee invite flow', async () => {
    const emp = await loginAgent(app, 'teller.priya', 'BankStaff#2026');
    const stem11 = '54321987654';
    const validAadhaar = stem11 + computeVerhoeffCheckDigit(stem11);

    const onboard = await emp.agent
      .post('/api/employee/customers')
      .set('X-CSRF-Token', emp.csrfToken)
      .send({
        fullName: 'Neha Deshpande',
        username: 'neha.deshpande',
        email: 'neha.d@example.com',
        mobile: '+919800000999', // Triggers simulated SMS delivery failure
        temporaryPassword: 'TempUser#2026',
        accountType: 'savings',
        aadhaarNumber: validAadhaar,
        openingDepositPaise: 250000,
      });

    expect(onboard.status).toBe(201);
    expect(onboard.body.customer.kycMaskedId).toBe(`XXXX-XXXX-${validAadhaar.slice(-4)}`);
    // Raw Aadhaar must NEVER exist anywhere in database tables
    const userRow = db.prepare('SELECT * FROM users WHERE username = ?').get('neha.deshpande');
    const auditRows = db.prepare('SELECT * FROM audit_logs').all();
    expect(JSON.stringify(userRow)).not.toContain(validAadhaar);
    expect(JSON.stringify(auditRows)).not.toContain(validAadhaar);
    // SMS delivery failure was logged without breaking customer onboarding/opening deposit
    const failedSms = db.prepare(`SELECT status FROM notifications WHERE user_id = ?`).get(onboard.body.customer.userId) as {
      status: string;
    };
    expect(failedSms.status).toBe('failed');

    // Employee adjustment limit enforcement
    const overEmpLimit = await emp.agent
      .post('/api/employee/adjustments')
      .set('X-CSRF-Token', emp.csrfToken)
      .send({
        accountId: onboard.body.customer.accountId,
        action: 'credit',
        amountPaise: 3_000_000, // Exceeds 2,500,000 limit
        reason: 'Large branch deposit',
        confirmed: true,
        idempotencyKey: 'emp-limit-1',
      });
    expect(overEmpLimit.status).toBe(403);
    expect(overEmpLimit.body.error).toBe('EMPLOYEE_LIMIT_EXCEEDED');

    // Manager invites employee via Gmail + mobile -> employee accepts with verification codes -> manager deactivates
    const mgr = await loginAgent(app, 'manager', '1234');
    await mgr.agent
      .post('/api/auth/change-password')
      .set('X-CSRF-Token', mgr.csrfToken)
      .send({ currentPassword: '1234', newPassword: 'ManagerSecure#2026' });

    const nonGmail = await mgr.agent
      .post('/api/manager/employees/invite')
      .set('X-CSRF-Token', mgr.csrfToken)
      .send({
        fullName: 'Vikram Joshi',
        email: 'vikram@yahoo.com',
        mobile: '+919811112222',
        department: 'Audit',
      });
    expect(nonGmail.status).toBe(400);

    const invite = await mgr.agent
      .post('/api/manager/employees/invite')
      .set('X-CSRF-Token', mgr.csrfToken)
      .send({
        fullName: 'Vikram Joshi',
        email: 'vikram.joshi@gmail.com',
        mobile: '+919811112222',
        department: 'Operations',
      });
    expect(invite.status).toBe(201);
    const { inviteToken, emailCode, mobileCode } = invite.body.sandboxVerification;

    const accept = await request(app).post('/api/auth/accept-invite').send({
      inviteToken,
      emailCode,
      mobileCode,
      username: 'teller.vikram',
      password: 'VikramStaff#2026',
    });
    expect(accept.status).toBe(201);

    const vikramLogin = await loginAgent(app, 'teller.vikram', 'VikramStaff#2026');
    expect(vikramLogin.res.status).toBe(200);
    expect(vikramLogin.res.body.user.role).toBe('employee');

    // Manager deactivates employee -> active session immediately rejected
    const deact = await mgr.agent
      .patch(`/api/manager/employees/${vikramLogin.res.body.user.id}/status`)
      .set('X-CSRF-Token', mgr.csrfToken)
      .send({ status: 'deactivated', reason: 'End of contract rotation' });
    expect(deact.status).toBe(200);

    const postDeact = await vikramLogin.agent.get('/api/employee/customers');
    expect(postDeact.status).toBe(401);
    const reLogin = await request(app).post('/api/auth/login').send({ username: 'teller.vikram', password: 'VikramStaff#2026' });
    expect(reLogin.status).toBe(403);
    expect(reLogin.body.error).toBe('ACCOUNT_DEACTIVATED');
    expect(verifyLedgerZeroSum(db).balanced).toBe(true);
  });

  it('enforces role-specific login portals and manager user/employee credential management without exposing password hashes', async () => {
    // 1. Cross-portal login attempts must be rejected with 403 ROLE_PORTAL_MISMATCH
    const userOnEmpPortal = await request(app)
      .post('/api/auth/login')
      .send({ username: 'aarav.sharma', password: 'Customer#2026', expectedRole: 'employee' });
    expect(userOnEmpPortal.status).toBe(403);
    expect(userOnEmpPortal.body.error).toBe('ROLE_PORTAL_MISMATCH');

    const empOnUserPortal = await request(app)
      .post('/api/auth/login')
      .send({ username: 'teller.priya', password: 'BankStaff#2026', expectedRole: 'user' });
    expect(empOnUserPortal.status).toBe(403);
    expect(empOnUserPortal.body.error).toBe('ROLE_PORTAL_MISMATCH');

    const mgrOnUserPortal = await request(app)
      .post('/api/auth/login')
      .send({ username: 'manager', password: '1234', expectedRole: 'user' });
    expect(mgrOnUserPortal.status).toBe(403);
    expect(mgrOnUserPortal.body.error).toBe('ROLE_PORTAL_MISMATCH');

    const mismatchLog = db
      .prepare(`SELECT action FROM audit_logs WHERE action = 'LOGIN_PORTAL_MISMATCH'`)
      .all();
    expect(mismatchLog.length).toBe(3);

    // 2. Non-managers cannot access /api/manager/credentials
    const cust = await loginAgent(app, 'aarav.sharma', 'Customer#2026');
    expect((await cust.agent.get('/api/manager/credentials')).status).toBe(403);

    // 3. Manager signs in via manager portal and changes initial password
    const mgrAgent = request.agent(app);
    const mgrLogin = await mgrAgent
      .post('/api/auth/login')
      .send({ username: 'manager', password: '1234', expectedRole: 'manager' });
    expect(mgrLogin.status).toBe(200);
    const mgrCsrf = mgrLogin.body.csrfToken as string;

    await mgrAgent
      .post('/api/auth/change-password')
      .set('X-CSRF-Token', mgrCsrf)
      .send({ currentPassword: '1234', newPassword: 'ManagerSecure#2026' });

    // 4. Manager lists all user & employee credentials; password_hash must never appear
    const listRes = await mgrAgent.get('/api/manager/credentials');
    expect(listRes.status).toBe(200);
    expect(listRes.body.credentials.some((c: { username: string }) => c.username === 'aarav.sharma')).toBe(true);
    expect(listRes.body.credentials.some((c: { username: string }) => c.username === 'teller.priya')).toBe(true);
    expect(JSON.stringify(listRes.body)).not.toContain('password_hash');

    // 5. Manager creates a user login and an employee login (non-Gmail employee rejected)
    const badEmpCreate = await mgrAgent
      .post('/api/manager/credentials/create')
      .set('X-CSRF-Token', mgrCsrf)
      .send({
        username: 'teller.bad',
        fullName: 'Bad Teller',
        email: 'bad@yahoo.com',
        mobile: '+919822223333',
        role: 'employee',
        temporaryPassword: 'TempStaff#2026',
      });
    expect(badEmpCreate.status).toBe(400);
    expect(badEmpCreate.body.error).toBe('GMAIL_REQUIRED');

    const createUserRes = await mgrAgent
      .post('/api/manager/credentials/create')
      .set('X-CSRF-Token', mgrCsrf)
      .send({
        username: 'ananya.rao',
        fullName: 'Ananya Rao',
        email: 'ananya.rao@example.com',
        mobile: '+919822224444',
        role: 'user',
        temporaryPassword: 'TempUser#2026',
        accountType: 'savings',
      });
    expect(createUserRes.status).toBe(201);
    expect(createUserRes.body.credential.accountNumber).toMatch(/^MTB/);
    expect(createUserRes.body.credential.mustChangePassword).toBe(true);

    const newUserId = createUserRes.body.credential.id as string;

    // 6. Lock the newly created user via 5 failed attempts, then unlock via manager
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ username: 'ananya.rao', password: 'WrongPassword', expectedRole: 'user' });
    }
    const lockedLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ananya.rao', password: 'TempUser#2026', expectedRole: 'user' });
    expect(lockedLogin.status).toBe(423);

    const unlockRes = await mgrAgent
      .post(`/api/manager/credentials/${newUserId}/unlock`)
      .set('X-CSRF-Token', mgrCsrf);
    expect(unlockRes.status).toBe(200);

    // Sign in with temporary password on User Login portal and confirm forced password change
    const tempUserAgent = request.agent(app);
    const tempLogin = await tempUserAgent
      .post('/api/auth/login')
      .send({ username: 'ananya.rao', password: 'TempUser#2026', expectedRole: 'user' });
    expect(tempLogin.status).toBe(200);
    expect(tempLogin.body.user.mustChangePassword).toBe(true);

    // 7. Manager resets user's password -> revokes old session and forces change on next login
    const resetRes = await mgrAgent
      .post(`/api/manager/credentials/${newUserId}/reset-password`)
      .set('X-CSRF-Token', mgrCsrf)
      .send({ temporaryPassword: 'ResetTemp#2026', reason: 'Customer branch ID reset' });
    expect(resetRes.status).toBe(200);

    const revokedCheck = await tempUserAgent.get('/api/accounts/me');
    expect(revokedCheck.status).toBe(401);

    const resetLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ananya.rao', password: 'ResetTemp#2026', expectedRole: 'user' });
    expect(resetLogin.status).toBe(200);
    expect(resetLogin.body.user.mustChangePassword).toBe(true);
  });
});
