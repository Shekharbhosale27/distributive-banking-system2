import { Router } from 'express';
import type Database from 'better-sqlite3';
import { AppConfig } from '../config.ts';
import { MAX_EMPLOYEE_ACCOUNTS } from '../db/database.ts';
import { createRateLimiter, requireAuth } from '../middleware/security.ts';
import {
  generateId,
  hashPassword,
  maskMobile,
  randomNumericCode,
  randomToken,
  sha256,
  verifyPassword,
} from '../security/crypto.ts';
import { recordAuditLog } from '../services/auditService.ts';
import { dispatchTransactionNotifications } from '../providers/emailProvider.ts';

export function createAuthRouter(db: Database.Database, config: AppConfig): Router {
  const router = Router();
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 30, keyPrefix: 'login' });
  const recoverLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 15, keyPrefix: 'recover' });

  router.post('/login', loginLimiter, (req, res) => {
    const { username, password, expectedRole } = (req.body || {}) as {
      username?: string;
      password?: string;
      expectedRole?: 'user' | 'employee' | 'manager';
    };
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Username and password are required.' });
      return;
    }
    if (expectedRole && !['user', 'employee', 'manager'].includes(expectedRole)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid login portal role.' });
      return;
    }

    const cleanUsername = username.trim().toLowerCase();
    const user = db
      .prepare('SELECT * FROM users WHERE lower(username) = ?')
      .get(cleanUsername) as
      | {
          id: string;
          username: string;
          email: string | null;
          mobile: string | null;
          full_name: string;
          password_hash: string;
          role: 'user' | 'employee' | 'manager';
          status: string;
          must_change_password: number;
          failed_login_attempts: number;
          locked_until: string | null;
          sms_opt_in: number;
          email_opt_in: number;
          kyc_status: string;
          kyc_masked_id: string | null;
          department: string | null;
        }
      | undefined;

    if (!user) {
      recordAuditLog(db, {
        actorUserId: null,
        actorRole: null,
        action: 'LOGIN_FAILED_UNKNOWN_USER',
        targetType: 'auth',
        targetId: cleanUsername,
        ipAddress: req.ip || null,
      });
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
      return;
    }

    if (user.status === 'deactivated') {
      res.status(403).json({ error: 'ACCOUNT_DEACTIVATED', message: 'This account has been deactivated.' });
      return;
    }

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      res.status(423).json({
        error: 'ACCOUNT_LOCKED',
        message: 'Account temporarily locked due to repeated failed attempts. Try again later or recover access.',
      });
      return;
    }

    if (!verifyPassword(password, user.password_hash)) {
      const nextFailures = user.failed_login_attempts + 1;
      const lockedUntil = nextFailures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?').run(
        nextFailures,
        lockedUntil,
        new Date().toISOString(),
        user.id,
      );
      recordAuditLog(db, {
        actorUserId: user.id,
        actorRole: user.role,
        action: lockedUntil ? 'ACCOUNT_LOCKED_FAILURES' : 'LOGIN_FAILED_BAD_PASSWORD',
        targetType: 'user',
        targetId: user.id,
        details: { attempts: nextFailures },
        ipAddress: req.ip || null,
      });
      res.status(lockedUntil ? 423 : 401).json({
        error: lockedUntil ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
        message: lockedUntil
          ? 'Account locked for 15 minutes after 5 failed login attempts.'
          : 'Invalid username or password.',
      });
      return;
    }

    if (expectedRole && user.role !== expectedRole) {
      const portalLabel =
        user.role === 'user' ? 'User Login' : user.role === 'employee' ? 'Employee Login' : 'Manager Login';
      recordAuditLog(db, {
        actorUserId: user.id,
        actorRole: user.role,
        action: 'LOGIN_PORTAL_MISMATCH',
        targetType: 'auth',
        targetId: expectedRole,
        ipAddress: req.ip || null,
      });
      res.status(403).json({
        error: 'ROLE_PORTAL_MISMATCH',
        message: `This account must sign in through the ${portalLabel} portal.`,
      });
      return;
    }

    // Reset failure counter and issue secure session
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionTtlHours * 3600_000).toISOString();
    const rawSessionToken = randomToken(32);
    const csrfToken = randomToken(24);
    const sessionId = generateId('sess');

    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(
      now.toISOString(),
      user.id,
    );

    db.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, csrf_token, expires_at, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      sha256(rawSessionToken),
      user.id,
      csrfToken,
      expiresAt,
      req.ip || null,
      req.headers['user-agent'] || null,
      now.toISOString(),
    );

    recordAuditLog(db, {
      actorUserId: user.id,
      actorRole: user.role,
      action: 'LOGIN_SUCCESS',
      targetType: 'user',
      targetId: user.id,
      ipAddress: req.ip || null,
    });

    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('mtb_session', rawSessionToken, {
      httpOnly: true,
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
      path: '/',
      maxAge: config.sessionTtlHours * 3600_000,
    });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        mobile: user.mobile,
        fullName: user.full_name,
        role: user.role,
        mustChangePassword: user.must_change_password === 1,
        smsOptIn: user.sms_opt_in === 1,
        emailOptIn: user.email_opt_in === 1,
        kycStatus: user.kyc_status,
        kycMaskedId: user.kyc_masked_id,
        department: user.department,
      },
      csrfToken,
      accessToken: rawSessionToken,
    });
  });

  router.post('/logout', (req, res) => {
    if (req.sessionId) {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), req.sessionId);
    }
    if (req.authUser) {
      recordAuditLog(db, {
        actorUserId: req.authUser.id,
        actorRole: req.authUser.role,
        action: 'LOGOUT',
        targetType: 'user',
        targetId: req.authUser.id,
        ipAddress: req.ip || null,
      });
    }
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.clearCookie('mtb_session', {
      path: '/',
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
    });
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    if (!req.authUser) {
      res.status(200).json({
        authenticated: false,
        user: null,
        csrfToken: null,
        devSeedEnabled: config.allowDevSeed,
      });
      return;
    }

    res.json({
      authenticated: true,
      user: req.authUser,
      csrfToken: req.csrfToken,
      devSeedEnabled: config.allowDevSeed,
    });
  });

  router.post('/change-password', requireAuth({ allowDuringForcedPasswordChange: true }), (req, res) => {
    const { currentPassword, newPassword } = (req.body || {}) as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword || !newPassword || typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Current and new passwords are required.' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: 'New password must be at least 8 characters long.' });
      return;
    }

    if (currentPassword === newPassword) {
      res.status(400).json({ error: 'PASSWORD_REUSE', message: 'New password must differ from current password.' });
      return;
    }

    const userRow = db
      .prepare('SELECT id, password_hash, role FROM users WHERE id = ?')
      .get(req.authUser!.id) as { id: string; password_hash: string; role: string } | undefined;

    if (!userRow || !verifyPassword(currentPassword, userRow.password_hash)) {
      res.status(401).json({ error: 'INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect.' });
      return;
    }

    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(
        hashPassword(newPassword),
        now,
        userRow.id,
      );
      // Revoke all other sessions for security hygiene
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').run(
        now,
        userRow.id,
        req.sessionId || '',
      );
    })();

    recordAuditLog(db, {
      actorUserId: userRow.id,
      actorRole: userRow.role,
      action: 'PASSWORD_CHANGED',
      targetType: 'user',
      targetId: userRow.id,
      ipAddress: req.ip || null,
    });

    res.json({ ok: true, message: 'Password updated successfully.' });
  });

  router.post('/recover/request', recoverLimiter, async (req, res) => {
    const { usernameOrEmail } = (req.body || {}) as { usernameOrEmail?: string };
    if (!usernameOrEmail || typeof usernameOrEmail !== 'string') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Username or email is required.' });
      return;
    }

    const lookup = usernameOrEmail.trim().toLowerCase();
    const user = db
      .prepare('SELECT id, username, mobile, email, role, status, sms_opt_in, email_opt_in FROM users WHERE lower(username) = ? OR lower(email) = ?')
      .get(lookup, lookup) as
      | {
          id: string;
          username: string;
          mobile: string | null;
          email: string | null;
          role: string;
          status: string;
          sms_opt_in: number;
          email_opt_in: number;
        }
      | undefined;

    let sandboxPreview: { recoveryToken?: string; maskedMobile?: string } | undefined;

    if (user && user.status === 'active') {
      const rawToken = randomToken(20);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
      db.prepare(
        `INSERT INTO password_recovery_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(generateId('rec'), user.id, sha256(rawToken), expiresAt, now.toISOString());

      await dispatchTransactionNotifications(db, config, {
        userId: user.id,
        mobile: user.mobile,
        email: user.email,
        smsOptIn: true,
        emailOptIn: true,
        subject: 'Meridian Trust Bank — Password Recovery Requested',
        message: `Meridian Trust Bank recovery code requested for ${user.username}. Valid for 15 minutes.`,
      });

      recordAuditLog(db, {
        actorUserId: user.id,
        actorRole: user.role,
        action: 'PASSWORD_RECOVERY_REQUESTED',
        targetType: 'user',
        targetId: user.id,
        ipAddress: req.ip || null,
      });

      if (!config.isProduction && config.allowDevSeed) {
        sandboxPreview = { recoveryToken: rawToken, maskedMobile: maskMobile(user.mobile) };
      }
    }

    // Never reveal account existence in production responses
    res.json({
      ok: true,
      message: 'If a matching active account exists, a recovery verification has been dispatched.',
      ...(sandboxPreview ? { sandboxPreview } : {}),
    });
  });

  router.post('/recover/confirm', recoverLimiter, (req, res) => {
    const { token, newPassword } = (req.body || {}) as { token?: string; newPassword?: string };
    if (!token || !newPassword || newPassword.length < 8) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Valid recovery token and new password (min 8 characters) are required.',
      });
      return;
    }

    const tokenHash = sha256(token.trim());
    const rec = db
      .prepare('SELECT * FROM password_recovery_tokens WHERE token_hash = ? AND used_at IS NULL')
      .get(tokenHash) as { id: string; user_id: string; expires_at: string } | undefined;

    if (!rec || new Date(rec.expires_at).getTime() <= Date.now()) {
      res.status(400).json({ error: 'INVALID_OR_EXPIRED_TOKEN', message: 'Recovery token is invalid or expired.' });
      return;
    }

    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE password_recovery_tokens SET used_at = ? WHERE id = ?').run(now, rec.id);
      db.prepare(
        `UPDATE users
         SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL, must_change_password = 0, updated_at = ?
         WHERE id = ?`,
      ).run(hashPassword(newPassword), now, rec.user_id);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, rec.user_id);
    })();

    recordAuditLog(db, {
      actorUserId: rec.user_id,
      actorRole: null,
      action: 'PASSWORD_RECOVERED',
      targetType: 'user',
      targetId: rec.user_id,
      ipAddress: req.ip || null,
    });

    res.json({ ok: true, message: 'Password reset completed. You may now sign in.' });
  });

  router.post('/accept-invite', recoverLimiter, (req, res) => {
    const { inviteToken, emailCode, mobileCode, username, password } = (req.body || {}) as {
      inviteToken?: string;
      emailCode?: string;
      mobileCode?: string;
      username?: string;
      password?: string;
    };

    if (!inviteToken || !emailCode || !mobileCode || !username || !password) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invite token, email verification code, mobile verification code, username, and password are required.',
      });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters long.' });
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

    const invite = db
      .prepare('SELECT * FROM employee_invites WHERE invite_token_hash = ?')
      .get(sha256(inviteToken.trim())) as
      | {
          id: string;
          email: string;
          mobile: string;
          full_name: string;
          department: string;
          email_code_hash: string;
          mobile_code_hash: string;
          status: string;
          expires_at: string;
          invited_by: string;
        }
      | undefined;

    if (!invite || invite.status !== 'pending') {
      res.status(400).json({ error: 'INVALID_INVITE', message: 'Invitation is invalid or no longer pending.' });
      return;
    }

    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      db.prepare(`UPDATE employee_invites SET status = 'expired', updated_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        invite.id,
      );
      res.status(400).json({ error: 'INVITE_EXPIRED', message: 'Invitation has expired.' });
      return;
    }

    if (sha256(emailCode.trim()) !== invite.email_code_hash || sha256(mobileCode.trim()) !== invite.mobile_code_hash) {
      res.status(400).json({
        error: 'CONTACT_VERIFICATION_FAILED',
        message: 'Email or mobile verification code does not match.',
      });
      return;
    }

    const conflict = db
      .prepare('SELECT id FROM users WHERE lower(username) = ? OR lower(email) = ? OR mobile = ?')
      .get(cleanUsername, invite.email.toLowerCase(), invite.mobile);

    if (conflict) {
      res.status(409).json({ error: 'USER_EXISTS', message: 'Username, email, or mobile is already registered.' });
      return;
    }

    const now = new Date().toISOString();
    const userId = generateId('usr');

    try {
      db.transaction(() => {
        const empCount = (db.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'employee'`).get() as { cnt: number }).cnt;
        if (empCount >= MAX_EMPLOYEE_ACCOUNTS) {
          const err = new Error(
            `Maximum capacity of ${MAX_EMPLOYEE_ACCOUNTS} employee IDs reached. Delete an existing employee first.`,
          ) as Error & { code?: string };
          err.code = 'EMPLOYEE_LIMIT_REACHED';
          throw err;
        }

        db.prepare(`
          INSERT INTO users (
            id, username, email, mobile, full_name, password_hash, role, status,
            must_change_password, sms_opt_in, email_opt_in, kyc_status, department, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'employee', 'active', 0, 1, 1, 'verified', ?, ?, ?)
        `).run(
          userId,
          cleanUsername,
          invite.email.toLowerCase(),
          invite.mobile,
          invite.full_name,
          hashPassword(password),
          invite.department,
          now,
          now,
        );

        db.prepare(`
          UPDATE employee_invites
          SET email_verified = 1, mobile_verified = 1, status = 'accepted', accepted_user_id = ?, updated_at = ?
          WHERE id = ?
        `).run(userId, now, invite.id);
      }).immediate();
    } catch (err) {
      if ((err as { code?: string }).code === 'EMPLOYEE_LIMIT_REACHED') {
        res.status(409).json({ error: 'EMPLOYEE_LIMIT_REACHED', message: (err as Error).message });
        return;
      }
      throw err;
    }

    recordAuditLog(db, {
      actorUserId: userId,
      actorRole: 'employee',
      action: 'EMPLOYEE_INVITE_ACCEPTED',
      targetType: 'employee_invite',
      targetId: invite.id,
      details: { email: invite.email, department: invite.department },
      ipAddress: req.ip || null,
    });

    res.status(201).json({
      ok: true,
      message: 'Contact details verified and employee account activated. You can now sign in.',
      username: cleanUsername,
    });
  });

  // Helper exported via closure? Not needed here.
  void randomNumericCode;
  return router;
}
