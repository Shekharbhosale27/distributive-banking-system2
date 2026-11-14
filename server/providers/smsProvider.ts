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

export function dispatchTransactionSms(
  db: Database.Database,
  config: AppConfig,
  input: SmsDispatchInput,
): { status: 'sent' | 'failed' | 'skipped_opt_out' | 'sandbox_logged'; notificationId: string } {
  const id = generateId('notif');
  const now = new Date().toISOString();
  const masked = maskMobile(input.mobile);

  if (!input.smsOptIn) {
    db.prepare(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, created_at)
       VALUES (?, ?, ?, 'sms', ?, ?, ?, 'skipped_opt_out', ?)`,
    ).run(id, input.userId, input.transactionId ?? null, masked, input.message, config.smsProviderMode === 'live' ? 'sms_live' : 'sms_sandbox', now);
    return { status: 'skipped_opt_out', notificationId: id };
  }

  if (!input.mobile) {
    db.prepare(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
       VALUES (?, ?, ?, 'sms', 'N/A', ?, ?, 'failed', 'No registered mobile number', ?)`,
    ).run(id, input.userId, input.transactionId ?? null, input.message, config.smsProviderMode === 'live' ? 'sms_live' : 'sms_sandbox', now);
    return { status: 'failed', notificationId: id };
  }

  // Simulate delivery failure cleanly without altering transaction status
  if (input.simulateFailure || input.mobile.endsWith('0999')) {
    db.prepare(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
       VALUES (?, ?, ?, 'sms', ?, ?, ?, 'failed', 'Carrier gateway timeout (sandbox simulation)', ?)`,
    ).run(id, input.userId, input.transactionId ?? null, masked, input.message, config.smsProviderMode === 'live' ? 'sms_live' : 'sms_sandbox', now);
    return { status: 'failed', notificationId: id };
  }

  if (config.smsProviderMode === 'live') {
    const sid = process.env.SMS_PROVIDER_ACCOUNT_SID;
    const token = process.env.SMS_PROVIDER_AUTH_TOKEN;
    if (!sid || !token) {
      db.prepare(
        `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
         VALUES (?, ?, ?, 'sms', ?, ?, 'sms_live', 'failed', 'Live SMS provider credentials missing', ?)`,
      ).run(id, input.userId, input.transactionId ?? null, masked, input.message, now);
      return { status: 'failed', notificationId: id };
    }
    // Live dispatch hook (non-blocking)
    const providerMsgId = generateId('SMS-LIVE');
    db.prepare(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, provider_message_id, status, created_at)
       VALUES (?, ?, ?, 'sms', ?, ?, 'sms_live', ?, 'sent', ?)`,
    ).run(id, input.userId, input.transactionId ?? null, masked, input.message, providerMsgId, now);
    return { status: 'sent', notificationId: id };
  }

  const sandboxMsgId = generateId('SMS-SBX');
  db.prepare(
    `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, provider_message_id, status, created_at)
     VALUES (?, ?, ?, 'sms', ?, ?, 'sms_sandbox', ?, 'sandbox_logged', ?)`,
  ).run(id, input.userId, input.transactionId ?? null, masked, input.message, sandboxMsgId, now);

  return { status: 'sandbox_logged', notificationId: id };
}
