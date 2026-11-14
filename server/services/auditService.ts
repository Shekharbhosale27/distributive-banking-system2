import type Database from 'better-sqlite3';
import { generateId } from '../security/crypto.ts';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'aadhaar',
  'aadhaarNumber',
  'pin',
  'otp',
  'token',
  'sessionToken',
  'csrfToken',
  'secret',
]);

function sanitizeDetails(obj: Record<string, unknown> | undefined): string {
  if (!obj) return '{}';
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) {
      clean[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      clean[k] = JSON.parse(sanitizeDetails(v as Record<string, unknown>));
    } else {
      clean[k] = v;
    }
  }
  return JSON.stringify(clean);
}

export function recordAuditLog(
  db: Database.Database,
  params: {
    actorUserId: string | null;
    actorRole: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    details?: Record<string, unknown>;
    ipAddress?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, actor_role, action, target_type, target_id, details_json, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateId('aud'),
    params.actorUserId,
    params.actorRole,
    params.action,
    params.targetType,
    params.targetId ?? null,
    sanitizeDetails(params.details),
    params.ipAddress ?? null,
    new Date().toISOString(),
  );
}
