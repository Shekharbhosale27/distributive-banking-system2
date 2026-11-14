import QRCode from 'qrcode';
import type Database from 'better-sqlite3';
import { AppConfig } from '../config.ts';
import { generateId, signHmac, verifyHmac } from '../security/crypto.ts';

export interface SignedQrPayload {
  v: 1;
  token: string;
  vpa: string;
  name: string;
  amountPaise: number | null;
  note: string | null;
  exp: string;
  sig: string;
}

function canonicalString(p: Omit<SignedQrPayload, 'sig'>): string {
  return `${p.v}|${p.token}|${p.vpa}|${p.name}|${p.amountPaise ?? ''}|${p.note ?? ''}|${p.exp}`;
}

export async function generateReceiveQr(
  db: Database.Database,
  config: AppConfig,
  params: {
    accountId: string;
    upiHandle: string;
    recipientName: string;
    amountPaise: number | null;
    note: string | null;
    ttlMinutes?: number;
  },
): Promise<{
  qrId: string;
  token: string;
  payloadString: string;
  qrDataUrl: string;
  expiresAt: string;
}> {
  const qrId = generateId('qr');
  const token = generateId('qrtok');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlMinutes ?? 30) * 60_000).toISOString();

  db.prepare(`
    INSERT INTO qr_payment_tokens (id, payload_token, merchant_account_id, amount_paise, note, expires_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(qrId, token, params.accountId, params.amountPaise, params.note, expiresAt, now.toISOString());

  const unsigned: Omit<SignedQrPayload, 'sig'> = {
    v: 1,
    token,
    vpa: params.upiHandle,
    name: params.recipientName,
    amountPaise: params.amountPaise,
    note: params.note,
    exp: expiresAt,
  };
  const sig = signHmac(canonicalString(unsigned), config.qrSigningSecret);
  const fullPayload: SignedQrPayload = { ...unsigned, sig };
  const payloadString = `MERIDIAN_QR:${Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url')}`;
  const qrDataUrl = await QRCode.toDataURL(payloadString, {
    width: 320,
    margin: 2,
    color: { dark: '#0F172A', light: '#FFFFFF' },
  });

  return { qrId, token, payloadString, qrDataUrl, expiresAt };
}

export function inspectQrPayload(
  db: Database.Database,
  config: AppConfig,
  rawPayload: string,
): {
  valid: boolean;
  reason?: string;
  token?: string;
  recipientName?: string;
  upiHandle?: string;
  merchantAccountId?: string;
  merchantAccountMasked?: string;
  amountPaise?: number | null;
  note?: string | null;
  expiresAt?: string;
} {
  const trimmed = rawPayload.trim();
  if (!trimmed.startsWith('MERIDIAN_QR:')) {
    return { valid: false, reason: 'Unrecognized QR format. Expected Meridian Trust Bank signed payment QR.' };
  }

  let parsed: SignedQrPayload;
  try {
    const encoded = trimmed.slice('MERIDIAN_QR:'.length);
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedQrPayload;
  } catch {
    return { valid: false, reason: 'Malformed QR payload data.' };
  }

  if (!parsed || parsed.v !== 1 || !parsed.token || !parsed.sig || !parsed.exp) {
    return { valid: false, reason: 'Incomplete QR payload fields.' };
  }

  const unsigned: Omit<SignedQrPayload, 'sig'> = {
    v: parsed.v,
    token: parsed.token,
    vpa: parsed.vpa,
    name: parsed.name,
    amountPaise: parsed.amountPaise ?? null,
    note: parsed.note ?? null,
    exp: parsed.exp,
  };

  if (!verifyHmac(canonicalString(unsigned), parsed.sig, config.qrSigningSecret)) {
    return { valid: false, reason: 'QR cryptographic signature verification failed.' };
  }

  const row = db
    .prepare(
      `SELECT q.*, a.account_number, a.upi_handle, u.full_name
       FROM qr_payment_tokens q
       JOIN accounts a ON a.id = q.merchant_account_id
       JOIN users u ON u.id = a.user_id
       WHERE q.payload_token = ?`,
    )
    .get(parsed.token) as
    | {
        id: string;
        merchant_account_id: string;
        amount_paise: number | null;
        note: string | null;
        expires_at: string;
        status: string;
        account_number: string;
        upi_handle: string | null;
        full_name: string;
      }
    | undefined;

  if (!row) {
    return { valid: false, reason: 'QR payment token does not exist.' };
  }

  if (row.status !== 'active') {
    return { valid: false, reason: `QR code is ${row.status} and can no longer be used.` };
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`UPDATE qr_payment_tokens SET status = 'expired' WHERE id = ?`).run(row.id);
    return { valid: false, reason: 'QR code has expired.' };
  }

  return {
    valid: true,
    token: parsed.token,
    recipientName: row.full_name,
    upiHandle: row.upi_handle || parsed.vpa,
    merchantAccountId: row.merchant_account_id,
    merchantAccountMasked: `••••${row.account_number.slice(-4)}`,
    amountPaise: row.amount_paise,
    note: row.note,
    expiresAt: row.expires_at,
  };
}
