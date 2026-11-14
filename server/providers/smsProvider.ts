import type Database from 'better-sqlite3';
import { AppConfig } from '../config.ts';
import { generateId, maskMobile } from '../security/crypto.ts';

export interface SmsDispatchInput {
  userId: string;
  mobile: string | null;
  smsOptIn: boolean;
  transactionId?: string;
  message: string;
  simulateFailure?: boolean;
}

export interface SmsDispatchResult {
  status: 'sent' | 'failed' | 'skipped_opt_out' | 'sandbox_logged';
  notificationId: string;
  provider: string;
  providerMessageId?: string | null;
  errorMessage?: string;
}

export function resolveActiveSmsAdapter(
  config: AppConfig,
): 'twilio' | 'msg91' | 'fast2sms' | 'webhook' | 'none' {
  if (config.smsProvider !== 'auto') {
    return config.smsProvider;
  }
  if (config.smsProviderAccountSid && config.smsProviderAuthToken && config.smsProviderFromNumber) {
    return 'twilio';
  }
  if (config.msg91AuthKey && config.msg91TemplateId) {
    return 'msg91';
  }
  if (config.fast2smsApiKey) {
    return 'fast2sms';
  }
  if (config.smsWebhookUrl) {
    return 'webhook';
  }
  return 'none';
}

export function isSmsLiveConfigured(config: AppConfig): boolean {
  const adapter = resolveActiveSmsAdapter(config);
  switch (adapter) {
    case 'twilio':
      return Boolean(config.smsProviderAccountSid && config.smsProviderAuthToken && config.smsProviderFromNumber);
    case 'msg91':
      return Boolean(config.msg91AuthKey && config.msg91TemplateId);
    case 'fast2sms':
      return Boolean(config.fast2smsApiKey);
    case 'webhook':
      return Boolean(config.smsWebhookUrl);
    default:
      return false;
  }
}

function normalizeE164Mobile(mobile: string): string {
  const stripped = mobile.trim().replace(/[^\d+]/g, '');
  if (stripped.startsWith('+')) return stripped;
  if (stripped.length === 10) return `+91${stripped}`;
  return `+${stripped}`;
}

async function sendViaTwilio(
  config: AppConfig,
  toMobile: string,
  message: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const sid = config.smsProviderAccountSid;
  const token = config.smsProviderAuthToken;
  const from = config.smsProviderFromNumber;
  if (!sid || !token || !from) {
    return { ok: false, error: 'Twilio SID, Auth Token, or From number missing.' };
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const form = new URLSearchParams({
    To: normalizeE164Mobile(toMobile),
    From: from,
    Body: message,
  });

  const authBasic = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authBasic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok || !data.sid) {
    return {
      ok: false,
      error: data.message ? `Twilio HTTP ${res.status}: ${data.message}` : `Twilio HTTP ${res.status}`,
    };
  }
  return { ok: true, messageId: data.sid };
}

async function sendViaMsg91(
  config: AppConfig,
  toMobile: string,
  message: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  if (!config.msg91AuthKey || !config.msg91TemplateId) {
    return { ok: false, error: 'MSG91 authkey or template_id missing.' };
  }

  const digitsOnly = normalizeE164Mobile(toMobile).replace(/^\+/, '');
  const res = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: {
      authkey: config.msg91AuthKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      template_id: config.msg91TemplateId,
      sender: config.msg91SenderId || 'MRDBNK',
      short_url: '0',
      recipients: [
        {
          mobiles: digitsOnly,
          message,
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await res.json().catch(() => ({}))) as { type?: string; message?: string; request_id?: string };
  if (!res.ok || data.type === 'error') {
    return { ok: false, error: data.message || `MSG91 HTTP ${res.status}` };
  }
  return { ok: true, messageId: data.request_id || generateId('MSG91') };
}

async function sendViaFast2Sms(
  config: AppConfig,
  toMobile: string,
  message: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  if (!config.fast2smsApiKey) {
    return { ok: false, error: 'Fast2SMS API key missing.' };
  }
  const tenDigit = normalizeE164Mobile(toMobile).replace(/^\+91/, '').replace(/\D/g, '').slice(-10);
  const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      authorization: config.fast2smsApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      route: 'q',
      message,
      language: 'english',
      flash: 0,
      numbers: tenDigit,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await res.json().catch(() => ({}))) as { return?: boolean; request_id?: string; message?: string | string[] };
  if (!res.ok || data.return === false) {
    const msg = Array.isArray(data.message) ? data.message.join(', ') : data.message;
    return { ok: false, error: msg || `Fast2SMS HTTP ${res.status}` };
  }
  return { ok: true, messageId: data.request_id || generateId('F2S') };
}

async function sendViaWebhook(
  config: AppConfig,
  toMobile: string,
  message: string,
  transactionId?: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  if (!config.smsWebhookUrl) {
    return { ok: false, error: 'SMS webhook URL missing.' };
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.smsWebhookBearerToken) {
    headers.Authorization = `Bearer ${config.smsWebhookBearerToken}`;
  }
  const res = await fetch(config.smsWebhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      channel: 'sms',
      to: normalizeE164Mobile(toMobile),
      from: config.smsProviderFromNumber,
      message,
      transactionId: transactionId ?? null,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string; error?: string };
  if (!res.ok) {
    return { ok: false, error: data.error || `SMS Webhook HTTP ${res.status}` };
  }
  return { ok: true, messageId: data.messageId || data.id || generateId('SMS-WHK') };
}

export async function dispatchTransactionSms(
  db: Database.Database,
  config: AppConfig,
  input: SmsDispatchInput,
): Promise<SmsDispatchResult> {
  const id = generateId('notif');
  const now = new Date().toISOString();
  const masked = maskMobile(input.mobile);
  const activeAdapter = resolveActiveSmsAdapter(config);
  const liveProviderLabel = activeAdapter === 'none' ? 'sms_live' : `sms_${activeAdapter}`;
  const providerName = config.smsProviderMode === 'live' ? liveProviderLabel : 'sms_sandbox';

  if (!input.smsOptIn) {
    db.prepare(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, created_at)
       VALUES (?, ?, ?, 'sms', ?, ?, ?, 'skipped_opt_out', ?)`,
    ).run(id, input.userId, input.transactionId ?? null, masked, input.message, providerName, now);
    return { status: 'skipped_opt_out', notificationId: id, provider: providerName };
  }

  if (!input.mobile) {
    db.prepare(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
       VALUES (?, ?, ?, 'sms', 'N/A', ?, ?, 'failed', 'No registered mobile number', ?)`,
    ).run(id, input.userId, input.transactionId ?? null, input.message, providerName, now);
    return { status: 'failed', notificationId: id, provider: providerName, errorMessage: 'No registered mobile number' };
  }

  // Deterministic sandbox failure path without altering settled transaction status
  if (input.simulateFailure || input.mobile.endsWith('0999')) {
    const errText = 'Carrier gateway timeout (simulated failure)';
    db.prepare(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
       VALUES (?, ?, ?, 'sms', ?, ?, ?, 'failed', ?, ?)`,
    ).run(id, input.userId, input.transactionId ?? null, masked, input.message, providerName, errText, now);
    return { status: 'failed', notificationId: id, provider: providerName, errorMessage: errText };
  }

  if (config.smsProviderMode === 'live') {
    if (!isSmsLiveConfigured(config)) {
      const errText = 'Live SMS provider credentials missing in server environment';
      db.prepare(
        `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
         VALUES (?, ?, ?, 'sms', ?, ?, ?, 'failed', ?, ?)`,
      ).run(id, input.userId, input.transactionId ?? null, masked, input.message, liveProviderLabel, errText, now);
      return { status: 'failed', notificationId: id, provider: liveProviderLabel, errorMessage: errText };
    }

    try {
      let outcome: { ok: true; messageId: string } | { ok: false; error: string };
      if (activeAdapter === 'twilio') {
        outcome = await sendViaTwilio(config, input.mobile, input.message);
      } else if (activeAdapter === 'msg91') {
        outcome = await sendViaMsg91(config, input.mobile, input.message);
      } else if (activeAdapter === 'fast2sms') {
        outcome = await sendViaFast2Sms(config, input.mobile, input.message);
      } else {
        outcome = await sendViaWebhook(config, input.mobile, input.message, input.transactionId);
      }

      if (!outcome.ok) {
        db.prepare(
          `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
           VALUES (?, ?, ?, 'sms', ?, ?, ?, 'failed', ?, ?)`,
        ).run(id, input.userId, input.transactionId ?? null, masked, input.message, liveProviderLabel, outcome.error, now);
        return { status: 'failed', notificationId: id, provider: liveProviderLabel, errorMessage: outcome.error };
      }

      db.prepare(
        `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, provider_message_id, status, created_at)
         VALUES (?, ?, ?, 'sms', ?, ?, ?, ?, 'sent', ?)`,
      ).run(id, input.userId, input.transactionId ?? null, masked, input.message, liveProviderLabel, outcome.messageId, now);
      return {
        status: 'sent',
        notificationId: id,
        provider: liveProviderLabel,
        providerMessageId: outcome.messageId,
      };
    } catch (err) {
      const safeErr = err instanceof Error ? err.message.slice(0, 180) : 'SMS provider network error';
      db.prepare(
        `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
         VALUES (?, ?, ?, 'sms', ?, ?, ?, 'failed', ?, ?)`,
      ).run(id, input.userId, input.transactionId ?? null, masked, input.message, liveProviderLabel, safeErr, now);
      return { status: 'failed', notificationId: id, provider: liveProviderLabel, errorMessage: safeErr };
    }
  }

  const sandboxMsgId = generateId('SMS-SBX');
  db.prepare(
    `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, provider_message_id, status, created_at)
     VALUES (?, ?, ?, 'sms', ?, ?, 'sms_sandbox', ?, 'sandbox_logged', ?)`,
  ).run(id, input.userId, input.transactionId ?? null, masked, input.message, sandboxMsgId, now);

  return {
    status: 'sandbox_logged',
    notificationId: id,
    provider: 'sms_sandbox',
    providerMessageId: sandboxMsgId,
  };
}
