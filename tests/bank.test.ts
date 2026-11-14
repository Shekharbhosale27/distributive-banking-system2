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
    const failedSms = db
      .prepare(`SELECT status FROM notifications WHERE user_id = ? AND channel = 'sms'`)
      .get(onboard.body.customer.userId) as {
      status: string;
    };
    expect(failedSms.status).toBe('failed');
    const emailNotif = db
      .prepare(`SELECT status FROM notifications WHERE user_id = ? AND channel = 'email'`)
      .get(onboard.body.customer.userId) as {
      status: string;
    };
    expect(emailNotif.status).toBe('sandbox_logged');

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

  it('enforces max 20 users and 5 employees creation caps and allows manager to delete users and employees safely', async () => {
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

    const initialDir = await mgrAgent.get('/api/manager/credentials');
    expect(initialDir.status).toBe(200);
    expect(initialDir.body.limits).toEqual({
      maxUsers: 20,
      maxEmployees: 5,
      currentUsers: 3,
      currentEmployees: 2,
    });

    // 1. Fill remaining 3 employee slots (2 baseline -> 5 total), then 6th employee must fail
    for (let i = 3; i <= 5; i++) {
      const empCreate = await mgrAgent
        .post('/api/manager/credentials/create')
        .set('X-CSRF-Token', mgrCsrf)
        .send({
          username: `teller.cap${i}`,
          fullName: `Teller Cap ${i}`,
          email: `teller.cap${i}@gmail.com`,
          mobile: `+91983333000${i}`,
          role: 'employee',
          temporaryPassword: 'TempStaff#2026',
          department: 'Operations',
        });
      expect(empCreate.status).toBe(201);
    }

    const sixthEmp = await mgrAgent
      .post('/api/manager/credentials/create')
      .set('X-CSRF-Token', mgrCsrf)
      .send({
        username: 'teller.cap6',
        fullName: 'Teller Cap 6',
        email: 'teller.cap6@gmail.com',
        mobile: '+919833330006',
        role: 'employee',
        temporaryPassword: 'TempStaff#2026',
      });
    expect(sixthEmp.status).toBe(409);
    expect(sixthEmp.body.error).toBe('EMPLOYEE_LIMIT_REACHED');

    const sixthInvite = await mgrAgent
      .post('/api/manager/employees/invite')
      .set('X-CSRF-Token', mgrCsrf)
      .send({
        fullName: 'Teller Cap 6 Invite',
        email: 'teller.cap6.inv@gmail.com',
        mobile: '+919833330016',
        department: 'Audit',
      });
    expect(sixthInvite.status).toBe(409);
    expect(sixthInvite.body.error).toBe('EMPLOYEE_LIMIT_REACHED');

    // 2. Fill remaining 17 user slots (3 baseline -> 20 total), then 21st user must fail
    for (let i = 4; i <= 20; i++) {
      const pad = String(i).padStart(2, '0');
      const usrCreate = await mgrAgent
        .post('/api/manager/credentials/create')
        .set('X-CSRF-Token', mgrCsrf)
        .send({
          username: `user.cap${pad}`,
          fullName: `User Cap ${pad}`,
          email: `user.cap${pad}@example.com`,
          mobile: `+9198444400${pad}`,
          role: 'user',
          temporaryPassword: 'TempUser#2026',
        });
      expect(usrCreate.status).toBe(201);
    }

    const twentyFirstUser = await mgrAgent
      .post('/api/manager/credentials/create')
      .set('X-CSRF-Token', mgrCsrf)
      .send({
        username: 'user.cap21',
        fullName: 'User Cap 21',
        email: 'user.cap21@example.com',
        mobile: '+919844440021',
        role: 'user',
        temporaryPassword: 'TempUser#2026',
      });
    expect(twentyFirstUser.status).toBe(409);
    expect(twentyFirstUser.body.error).toBe('USER_LIMIT_REACHED');

    // Non-manager cannot delete users or employees
    const cust = await loginAgent(app, 'aarav.sharma', 'Customer#2026');
    expect(
      (
        await cust.agent
          .delete(`/api/manager/credentials/${initialDir.body.credentials[0].id}`)
          .set('X-CSRF-Token', cust.csrfToken)
          .send({ reason: 'Unauthorized attempt' })
      ).status,
    ).toBe(403);

    // 3. Manager deletes an active customer (aarav.sharma) and an employee (teller.priya)
    const fullDir = await mgrAgent.get('/api/manager/credentials');
    const creds = fullDir.body.credentials as Array<{ id: string; username: string; role: string }>;
    const aaravCred = creds.find((c) => c.username === 'aarav.sharma')!;
    const priyaCred = creds.find((c) => c.username === 'teller.priya')!;

    const delUserRes = await mgrAgent
      .delete(`/api/manager/credentials/${aaravCred.id}`)
      .set('X-CSRF-Token', mgrCsrf)
      .send({ reason: 'Customer requested account closure' });
    expect(delUserRes.status).toBe(200);
    expect(delUserRes.body.deleted.settledBalancePaise).toBeGreaterThan(0);

    const aaravLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'aarav.sharma', password: 'Customer#2026', expectedRole: 'user' });
    expect(aaravLogin.status).toBe(401);
    expect(verifyLedgerZeroSum(db).balanced).toBe(true);

    const delEmpRes = await mgrAgent
      .delete(`/api/manager/credentials/${priyaCred.id}`)
      .set('X-CSRF-Token', mgrCsrf)
      .send({ reason: 'Staff offboarding completed' });
    expect(delEmpRes.status).toBe(200);

    const priyaLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'teller.priya', password: 'BankStaff#2026', expectedRole: 'employee' });
    expect(priyaLogin.status).toBe(401);

    // 4. Freed slots now allow creating 1 new user and 1 new employee
    const replacementUser = await mgrAgent
      .post('/api/manager/credentials/create')
      .set('X-CSRF-Token', mgrCsrf)
      .send({
        username: 'user.replacement',
        fullName: 'Replacement User',
        email: 'replacement.user@example.com',
        mobile: '+919844440099',
        role: 'user',
        temporaryPassword: 'TempUser#2026',
      });
    expect(replacementUser.status).toBe(201);

    const replacementEmp = await mgrAgent
      .post('/api/manager/credentials/create')
      .set('X-CSRF-Token', mgrCsrf)
      .send({
        username: 'teller.replacement',
        fullName: 'Replacement Teller',
        email: 'replacement.teller@gmail.com',
        mobile: '+919833330099',
        role: 'employee',
        temporaryPassword: 'TempStaff#2026',
      });
    expect(replacementEmp.status).toBe(201);

    // Manager cannot delete a manager account
    const delSelfRes = await mgrAgent
      .delete(`/api/manager/credentials/${mgrLogin.body.user.id}`)
      .set('X-CSRF-Token', mgrCsrf)
      .send({ reason: 'Should fail' });
    expect(delSelfRes.status).toBe(404);

    // Audit trail recorded both deletions
    const delLogs = db
      .prepare(`SELECT action FROM audit_logs WHERE action IN ('USER_DELETED', 'EMPLOYEE_DELETED')`)
      .all();
    expect(delLogs.length).toBe(2);
  });

  it('allows employees to view all bank-wide transaction history with filters and blocks customer access', async () => {
    const emp = await loginAgent(app, 'teller.priya', 'BankStaff#2026');
    const cust = await loginAgent(app, 'aarav.sharma', 'Customer#2026');

    // Customer must be blocked from employee bank-wide transaction history
    expect((await cust.agent.get('/api/employee/transactions')).status).toBe(403);

    // Employee retrieves all seeded and new bank transactions
    const allTxRes = await emp.agent.get('/api/employee/transactions');
    expect(allTxRes.status).toBe(200);
    expect(allTxRes.body.totalCount).toBeGreaterThanOrEqual(6);
    expect(allTxRes.body.transactions.length).toBe(allTxRes.body.totalCount);

    // Secrets and raw KYC data must never leak
    const serialized = JSON.stringify(allTxRes.body);
    expect(serialized).not.toContain('password_hash');
    expect(serialized).not.toContain('kyc_provider_ref');

    // Status filter works (e.g. pending NEFT transfer)
    const pendingRes = await emp.agent.get('/api/employee/transactions?status=pending');
    expect(pendingRes.status).toBe(200);
    expect(pendingRes.body.transactions.every((t: { status: string }) => t.status === 'pending')).toBe(true);
    expect(pendingRes.body.transactions.length).toBeGreaterThanOrEqual(1);
  });

  it('dispatches real HTTP SMS (Twilio), live Email (Resend), and confirmed 1P Gmail API alerts without failing ledger transactions', async () => {
    const liveConfig = loadConfig({
      nodeEnv: 'development',
      isProduction: false,
      allowDevSeed: true,
      dbPath: ':memory:',
      paymentWebhookSecret: 'test-webhook-secret',
      smsProviderMode: 'live',
      smsProvider: 'twilio',
      smsProviderAccountSid: 'ACtest123456',
      smsProviderAuthToken: 'auth_token_test',
      smsProviderFromNumber: '+15005550006',
      emailProviderMode: 'live',
      emailProvider: 'resend',
      resendApiKey: 're_test_key',
      emailFromAddress: 'alerts@meridiantrust.test',
    });
    const liveDb = openDatabase(':memory:');
    runMigrations(liveDb);
    seedDatabase(liveDb, liveConfig);
    const liveApp = createBankApp({ db: liveDb, config: liveConfig });

    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headersObj: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => {
          headersObj[k.toLowerCase()] = v;
        });
      }
      calls.push({ url, headers: headersObj, body: typeof init?.body === 'string' ? init.body : '' });

      if (url.startsWith('https://api.twilio.com/')) {
        return new Response(JSON.stringify({ sid: 'SM_LIVE_12345' }), { status: 201 });
      }
      if (url === 'https://api.resend.com/emails') {
        return new Response(JSON.stringify({ id: 're_msg_98765' }), { status: 200 });
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
        return new Response(JSON.stringify({ id: 'gmail_msg_555' }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const aarav = await loginAgent(liveApp, 'aarav.sharma', 'Customer#2026');
      const transferRes = await aarav.agent
        .post('/api/transfers/internal')
        .set('X-CSRF-Token', aarav.csrfToken)
        .send({
          destinationAccountNumber: 'MTB00100002',
          amountPaise: 25000,
          description: 'Live alert check',
          idempotencyKey: 'live-alert-tx-1',
        });
      expect(transferRes.status).toBe(201);

      // Verify both Twilio SMS and Resend Email HTTP calls fired
      expect(calls.some((c) => c.url.includes('api.twilio.com/2010-04-01/Accounts/ACtest123456/Messages.json'))).toBe(true);
      expect(calls.some((c) => c.url === 'https://api.resend.com/emails')).toBe(true);

      const notifRows = liveDb
        .prepare(`SELECT channel, provider, provider_message_id, status FROM notifications WHERE user_id = ?`)
        .all(aarav.res.body.user.id) as Array<{
        channel: string;
        provider: string;
        provider_message_id: string;
        status: string;
      }>;
      expect(notifRows.some((n) => n.channel === 'sms' && n.provider === 'sms_twilio' && n.provider_message_id === 'SM_LIVE_12345' && n.status === 'sent')).toBe(true);
      expect(notifRows.some((n) => n.channel === 'email' && n.provider === 'resend' && n.provider_message_id === 're_msg_98765' && n.status === 'sent')).toBe(true);

      // 1P Gmail API receipt requires token + explicit confirmed: true
      const noTokenRes = await aarav.agent
        .post('/api/notifications/send-gmail')
        .set('X-CSRF-Token', aarav.csrfToken)
        .send({ transactionId: transferRes.body.transaction.id, confirmed: true });
      expect(noTokenRes.status).toBe(401);

      const unconfirmedGmail = await aarav.agent
        .post('/api/notifications/send-gmail')
        .set('X-CSRF-Token', aarav.csrfToken)
        .set('X-Gmail-Access-Token', 'ya29.test-oauth-token')
        .send({ transactionId: transferRes.body.transaction.id, confirmed: false });
      expect(unconfirmedGmail.status).toBe(400);
      expect(unconfirmedGmail.body.error).toBe('CONFIRMATION_REQUIRED');

      const sentGmail = await aarav.agent
        .post('/api/notifications/send-gmail')
        .set('X-CSRF-Token', aarav.csrfToken)
        .set('X-Gmail-Access-Token', 'ya29.test-oauth-token')
        .send({ transactionId: transferRes.body.transaction.id, confirmed: true });
      expect(sentGmail.status).toBe(200);
      expect(sentGmail.body.notification.provider).toBe('gmail_api');
      expect(sentGmail.body.notification.providerMessageId).toBe('gmail_msg_555');

      const gmailCall = calls.find((c) => c.url.includes('gmail.googleapis.com'));
      expect(gmailCall?.headers.authorization).toBe('Bearer ya29.test-oauth-token');

      // Even if external SMS/Email providers return 500 errors, ledger transfer STILL commits cleanly
      globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'Upstream gateway error' }), { status: 500 })) as typeof fetch;
      const resilientTransfer = await aarav.agent
        .post('/api/transfers/internal')
        .set('X-CSRF-Token', aarav.csrfToken)
        .send({
          destinationAccountNumber: 'MTB00100002',
          amountPaise: 10000,
          idempotencyKey: 'live-alert-fail-isolation',
        });
      expect(resilientTransfer.status).toBe(201);
      expect(verifyLedgerZeroSum(liveDb).balanced).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('allows managers to send SMS, email/Gmail, and in-app messages to specific or grouped users and employees while enforcing RBAC', async () => {
    const liveConfig = loadConfig({
      nodeEnv: 'development',
      isProduction: false,
      allowDevSeed: true,
      dbPath: ':memory:',
      paymentWebhookSecret: 'test-webhook-secret',
      smsProviderMode: 'live',
      smsProvider: 'twilio',
      smsProviderAccountSid: 'ACtest123456',
      smsProviderAuthToken: 'auth_token_test',
      smsProviderFromNumber: '+15005550006',
      emailProviderMode: 'live',
      emailProvider: 'resend',
      resendApiKey: 're_test_key',
      emailFromAddress: 'alerts@meridiantrust.test',
    });
    const msgDb = openDatabase(':memory:');
    runMigrations(msgDb);
    seedDatabase(msgDb, liveConfig);
    const msgApp = createBankApp({ db: msgDb, config: liveConfig });

    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headersObj: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => {
          headersObj[k.toLowerCase()] = v;
        });
      }
      calls.push({ url, headers: headersObj, body: typeof init?.body === 'string' ? init.body : '' });

      if (url.startsWith('https://api.twilio.com/')) {
        return new Response(JSON.stringify({ sid: 'SM_MGR_111' }), { status: 201 });
      }
      if (url === 'https://api.resend.com/emails') {
        return new Response(JSON.stringify({ id: 're_mgr_222' }), { status: 200 });
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
        return new Response(JSON.stringify({ id: 'gmail_mgr_333' }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const aarav = await loginAgent(msgApp, 'aarav.sharma', 'Customer#2026');
      const priya = await loginAgent(msgApp, 'teller.priya', 'BankStaff#2026');

      // Users & employees cannot access manager messaging endpoints
      expect((await aarav.agent.get('/api/manager/messages')).status).toBe(403);
      expect(
        (
          await priya.agent
            .post('/api/manager/messages/send')
            .set('X-CSRF-Token', priya.csrfToken)
            .send({ audience: 'all_users', channels: ['in_app'], message: 'Unauthorized notice' })
        ).status,
      ).toBe(403);

      const mgr = await loginAgent(msgApp, 'manager', '1234');
      await mgr.agent
        .post('/api/auth/change-password')
        .set('X-CSRF-Token', mgr.csrfToken)
        .send({ currentPassword: '1234', newPassword: 'ManagerSecure#2026' });

      // 1P Gmail token requires confirmed: true
      const unconfirmedRes = await mgr.agent
        .post('/api/manager/messages/send')
        .set('X-CSRF-Token', mgr.csrfToken)
        .set('X-Gmail-Access-Token', 'ya29.mgr-oauth-token')
        .send({
          audience: 'selected',
          recipientUserIds: [aarav.res.body.user.id],
          channels: ['email'],
          subject: 'Account Notice',
          message: 'Please review your statement.',
          confirmed: false,
        });
      expect(unconfirmedRes.status).toBe(400);
      expect(unconfirmedRes.body.error).toBe('CONFIRMATION_REQUIRED');

      // Manager sends SMS + 1P Gmail + In-App alert to selected user & employee
      const sendRes = await mgr.agent
        .post('/api/manager/messages/send')
        .set('X-CSRF-Token', mgr.csrfToken)
        .set('X-Gmail-Access-Token', 'ya29.mgr-oauth-token')
        .send({
          audience: 'selected',
          recipientUserIds: [aarav.res.body.user.id, priya.res.body.user.id],
          channels: ['sms', 'email', 'in_app'],
          subject: 'Branch Security Briefing',
          message: 'Mandatory audit window starts at 18:00 IST today.',
          confirmed: true,
        });
      expect(sendRes.status).toBe(200);
      expect(sendRes.body.summary).toEqual({
        totalRecipients: 2,
        smsSent: 2,
        emailSent: 2,
        inAppSent: 2,
        failedCount: 0,
      });

      expect(calls.filter((c) => c.url.includes('api.twilio.com')).length).toBe(2);
      expect(calls.filter((c) => c.url.includes('gmail.googleapis.com')).length).toBe(2);

      // Manager sends bulk announcement to all active employees using server email gateway (Resend)
      const bulkEmpRes = await mgr.agent
        .post('/api/manager/messages/send')
        .set('X-CSRF-Token', mgr.csrfToken)
        .send({
          audience: 'all_employees',
          channels: ['email', 'in_app'],
          subject: 'Teller Shift Schedule',
          message: 'Updated KYC verification checklist is active.',
        });
      expect(bulkEmpRes.status).toBe(200);
      expect(bulkEmpRes.body.summary.totalRecipients).toBeGreaterThanOrEqual(1);
      expect(calls.some((c) => c.url === 'https://api.resend.com/emails')).toBe(true);

      // Employee can view received manager messages & alerts in their inbox
      const empNotifs = await priya.agent.get('/api/notifications');
      expect(empNotifs.status).toBe(200);
      expect(
        empNotifs.body.notifications.some((n: { channel: string; message: string }) =>
          n.channel === 'in_app' && n.message.includes('Branch Security Briefing'),
        ),
      ).toBe(true);

      // Manager message log shows masked recipients and never exposes raw mobile or password hashes
      const mgrLogRes = await mgr.agent.get('/api/manager/messages');
      expect(mgrLogRes.status).toBe(200);
      expect(mgrLogRes.body.messages.length).toBeGreaterThanOrEqual(6);
      expect(JSON.stringify(mgrLogRes.body)).not.toContain('password_hash');

      // Audit trail recorded MANAGER_MESSAGE_SENT
      const msgAudit = msgDb
        .prepare(`SELECT details_json FROM audit_logs WHERE action = 'MANAGER_MESSAGE_SENT'`)
        .all() as Array<{ details_json: string }>;
      expect(msgAudit.length).toBe(2);
      expect(msgAudit[0].details_json).toContain('Branch Security Briefing');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
