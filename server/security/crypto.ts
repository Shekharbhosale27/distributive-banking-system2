import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, originalHex] = parts;
  if (!salt || !originalHex) return false;
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const original = Buffer.from(originalHex, 'hex');
  if (derived.length !== original.length) return false;
  return crypto.timingSafeEqual(derived, original);
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomNumericCode(digits = 6): string {
  const max = 10 ** digits;
  const min = 10 ** (digits - 1);
  return String(crypto.randomInt(min, max));
}

export function generateId(prefix = ''): string {
  const uuid = crypto.randomUUID();
  return prefix ? `${prefix}_${uuid}` : uuid;
}

export function generateReferenceCode(prefix = 'TXN'): string {
  const now = new Date();
  const datePart = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${datePart}-${rand}`;
}

export function signHmac(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyHmac(payload: string, signatureHex: string, secret: string): boolean {
  const expected = signHmac(payload, secret);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signatureHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function maskMobile(mobile: string | null | undefined): string {
  if (!mobile) return 'N/A';
  const cleaned = mobile.trim();
  if (cleaned.length <= 4) return '****';
  return `${cleaned.slice(0, 3)}****${cleaned.slice(-4)}`;
}

export function maskAccountNumber(accountNumber: string | null | undefined): string {
  if (!accountNumber) return 'N/A';
  const cleaned = accountNumber.trim();
  if (cleaned.length <= 4) return '****';
  return `••••${cleaned.slice(-4)}`;
}

export function maskAadhaarLast4(aadhaarDigits: string): string {
  const digits = aadhaarDigits.replace(/\D/g, '');
  if (digits.length < 4) return 'XXXX-XXXX-XXXX';
  return `XXXX-XXXX-${digits.slice(-4)}`;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return 'N/A';
  const cleaned = email.trim();
  const atIndex = cleaned.indexOf('@');
  if (atIndex <= 0) return '***';
  const local = cleaned.slice(0, atIndex);
  const domain = cleaned.slice(atIndex + 1);
  if (local.length <= 2) {
    return `${local[0] || '*'}***@${domain}`;
  }
  return `${local.slice(0, 2)}***${local.slice(-1)}@${domain}`;
}
