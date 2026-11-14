import type { NextFunction, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { sha256 } from '../security/crypto.ts';
import { recordAuditLog } from '../services/auditService.ts';

export type UserRole = 'user' | 'employee' | 'manager';

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string | null;
  mobile: string | null;
  fullName: string;
  role: UserRole;
  status: string;
  mustChangePassword: boolean;
  smsOptIn: boolean;
  emailOptIn: boolean;
  kycStatus: string;
  kycMaskedId: string | null;
  department: string | null;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
      sessionId?: string;
      csrfToken?: string;
      authMethod?: 'cookie' | 'bearer';
    }
  }
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = decodeURIComponent(part.slice(0, idx).trim());
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    result[key] = val;
  }
  return result;
}

export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self)');
  next();
}

export function createRateLimiter(options: { windowMs: number; max: number; keyPrefix: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = `${options.keyPrefix}:${req.ip || 'unknown'}`;
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (entry.count >= options.max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many requests. Please wait before trying again.',
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    entry.count += 1;
    next();
  };
}

export function createAuthMiddleware(db: Database.Database) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cookies = parseCookies(req.headers.cookie);
    const authHeader = req.headers.authorization;
    let rawToken: string | undefined;
    let authMethod: 'cookie' | 'bearer' = 'cookie';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      rawToken = authHeader.slice('Bearer '.length).trim();
      authMethod = 'bearer';
    } else if (cookies.mtb_session) {
      rawToken = cookies.mtb_session;
      authMethod = 'cookie';
    }

    if (!rawToken) {
      next();
      return;
    }

    const tokenHash = sha256(rawToken);
    const row = db
      .prepare(
        `SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.revoked_at,
                u.id, u.username, u.email, u.mobile, u.full_name, u.role, u.status,
                u.must_change_password, u.sms_opt_in, u.email_opt_in, u.kyc_status,
                u.kyc_masked_id, u.department
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as
      | {
          session_id: string;
          csrf_token: string;
          expires_at: string;
          revoked_at: string | null;
          id: string;
          username: string;
          email: string | null;
          mobile: string | null;
          full_name: string;
          role: UserRole;
          status: string;
          must_change_password: number;
          sms_opt_in: number;
          email_opt_in: number;
          kyc_status: string;
          kyc_masked_id: string | null;
          department: string | null;
        }
      | undefined;

    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
      next();
      return;
    }

    if (row.status !== 'active') {
      res.status(403).json({
        error: 'ACCOUNT_INACTIVE',
        message: 'This account is deactivated or locked. Contact bank governance.',
      });
      return;
    }

    // Enforce CSRF token on cookie-authenticated state-changing requests
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase());
    if (authMethod === 'cookie' && isMutating) {
      const providedCsrf = req.headers['x-csrf-token'];
      if (!providedCsrf || providedCsrf !== row.csrf_token) {
        res.status(403).json({
          error: 'CSRF_VALIDATION_FAILED',
          message: 'Missing or invalid CSRF token.',
        });
        return;
      }
    }

    req.sessionId = row.session_id;
    req.csrfToken = row.csrf_token;
    req.authMethod = authMethod;
    req.authUser = {
      id: row.id,
      username: row.username,
      email: row.email,
      mobile: row.mobile,
      fullName: row.full_name,
      role: row.role,
      status: row.status,
      mustChangePassword: row.must_change_password === 1,
      smsOptIn: row.sms_opt_in === 1,
      emailOptIn: row.email_opt_in === 1,
      kycStatus: row.kyc_status,
      kycMaskedId: row.kyc_masked_id,
      department: row.department,
    };

    next();
  };
}

export function requireAuth(options: { allowDuringForcedPasswordChange?: boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Authentication is required.' });
      return;
    }
    if (req.authUser.mustChangePassword && !options.allowDuringForcedPasswordChange) {
      res.status(403).json({
        error: 'PASSWORD_CHANGE_REQUIRED',
        message: 'You must change your initial password before accessing banking features.',
      });
      return;
    }
    next();
  };
}

export function requireRole(db: Database.Database, ...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Authentication is required.' });
      return;
    }
    if (req.authUser.mustChangePassword) {
      res.status(403).json({
        error: 'PASSWORD_CHANGE_REQUIRED',
        message: 'You must change your initial password first.',
      });
      return;
    }
    if (!allowedRoles.includes(req.authUser.role)) {
      recordAuditLog(db, {
        actorUserId: req.authUser.id,
        actorRole: req.authUser.role,
        action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        targetType: 'route',
        targetId: `${req.method} ${req.originalUrl}`,
        ipAddress: req.ip || null,
      });
      res.status(403).json({
        error: 'FORBIDDEN',
        message: `Access denied. Required role: ${allowedRoles.join(' or ')}.`,
      });
      return;
    }
    next();
  };
}
