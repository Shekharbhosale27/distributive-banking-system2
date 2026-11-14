import type Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import { AppConfig } from '../config.ts';
import { generateId, maskEmail } from '../security/crypto.ts';
import { dispatchTransactionSms, type SmsDispatchResult } from './smsProvider.ts';

export interface EmailDispatchInput {
  userId: string;
  email: string | null;
  emailOptIn: boolean;
  transactionId?: string;
  subject: string;
  message: string;
  htmlBody?: string;
  gmailAccessToken?: string;
  simulateFailure?: boolean;
}

export interface EmailDispatchResult {
  status: 'sent' | 'failed' | 'skipped_opt_out' | 'sandbox_logged';
  notificationId: string;
  provider: string;
  providerMessageId?: string | null;
  errorMessage?: string;
}

export function resolveActiveEmailAdapter(
  config: AppConfig,
): 'gmail_smtp' | 'resend' | 'sendgrid' | 'webhook' | 'none' {
  if (config.emailProvider !== 'auto') {
    return config.emailProvider;
  }
  if (config.gmailSmtpUser && config.gmailSmtpAppPassword) {
    return 'gmail_smtp';
  }
  if (config.resendApiKey && config.emailFromAddress) {
    return 'resend';
  }
  if (config.sendgridApiKey && config.emailFromAddress) {
    return 'sendgrid';
  }
  if (config.emailWebhookUrl) {
    return 'webhook';
  }
  return 'none';
}

export function isEmailLiveConfigured(config: AppConfig): boolean {
  const adapter = resolveActiveEmailAdapter(config);
  switch (adapter) {
    case 'gmail_smtp':
      return Boolean(config.gmailSmtpUser && config.gmailSmtpAppPassword);
    case 'resend':
      return Boolean(config.resendApiKey && config.emailFromAddress);
    case 'sendgrid':
      return Boolean(config.sendgridApiKey && config.emailFromAddress);
    case 'webhook':
      return Boolean(config.emailWebhookUrl);
    default:
      return false;
  }
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function buildDefaultHtml(subject: string, message: string): string {
  const escapedSubject = subject.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || c));
  const escapedMsg = message
    .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || c))
    .replace(/\n/g, '<br/>');

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; background: #ffffff;">
      <div style="background: #0a2e2a; color: #ffffff; padding: 18px 24px;">
        <div style="font-size: 16px; font-weight: 700;">Meridian Trust Bank</div>
        <div style="font-size: 12px; color: #a7f3d0; margin-top: 2px;">Automated Transaction Alert</div>
      </div>
      <div style="padding: 24px; color: #0f172a; font-size: 14px; line-height: 1.6;">
        <h2 style="margin: 0 0 12px 0; font-size: 16px; color: #0f172a;">${escapedSubject}</h2>
        <p style="margin: 0 0 16px 0;">${escapedMsg}</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 18px 0;" />
        <p style="margin: 0; font-size: 12px; color: #64748b;">
          For security, Meridian Trust Bank never asks for passwords, PINs, or OTPs via email or SMS.
        </p>
      </div>
    </div>
  `.trim();
}

async function sendViaGmailWorkspaceApi(
  accessToken: string,
  toEmail: string,
  subject: string,
  textBody: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const safeTo = sanitizeHeaderValue(toEmail);
  const safeSubject = sanitizeHeaderValue(subject);
  const mimeLines = [
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    textBody,
  ];
  const rawBase64Url = Buffer.from(mimeLines.join('\r\n'), 'utf8').toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: rawBase64Url }),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string; code?: number } };
  if (!res.ok || !data.id) {
    return {
      ok: false,
      error: data.error?.message ? `Gmail API HTTP ${res.status}: ${data.error.message}` : `Gmail API HTTP ${res.status}`,
    };
  }
  return { ok: true, messageId: data.id };
}

async function sendViaGmailSmtp(
  config: AppConfig,
  toEmail: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  if (!config.gmailSmtpUser || !config.gmailSmtpAppPassword) {
    return { ok: false, error: 'Gmail SMTP user or App Password missing.' };
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    auth: {
      user: config.gmailSmtpUser,
      pass: config.gmailSmtpAppPassword,
    },
  });

  const fromAddr = config.emailFromAddress || config.gmailSmtpUser;
  const info = await transporter.sendMail({
    from: `"${sanitizeHeaderValue(config.emailFromName)}" <${sanitizeHeaderValue(fromAddr)}>`,
    to: sanitizeHeaderValue(toEmail),
    subject: sanitizeHeaderValue(subject),
    text: textBody,
    html: htmlBody,
  });

  return { ok: true, messageId: info.messageId || generateId('GMAIL-SMTP') };
}

async function sendViaResend(
  config: AppConfig,
  toEmail: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  if (!config.resendApiKey || !config.emailFromAddress) {
    return { ok: false, error: 'Resend API key or EMAIL_FROM_ADDRESS missing.' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${sanitizeHeaderValue(config.emailFromName)} <${sanitizeHeaderValue(config.emailFromAddress)}>`,
      to: [sanitizeHeaderValue(toEmail)],
      subject: sanitizeHeaderValue(subject),
      text: textBody,
      html: htmlBody,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok || !data.id) {
    return { ok: false, error: data.message || `Resend HTTP ${res.status}` };
  }
  return { ok: true, messageId: data.id };
}

async function sendViaSendGrid(
  config: AppConfig,
  toEmail: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  if (!config.sendgridApiKey || !config.emailFromAddress) {
    return { ok: false, error: 'SendGrid API key or EMAIL_FROM_ADDRESS missing.' };
  }

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.sendgridApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: sanitizeHeaderValue(toEmail) }] }],
      from: { email: sanitizeHeaderValue(config.emailFromAddress), name: sanitizeHeaderValue(config.emailFromName) },
      subject: sanitizeHeaderValue(subject),
      content: [
        { type: 'text/plain', value: textBody },
        { type: 'text/html', value: htmlBody },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    return { ok: false, error: bodyText ? `SendGrid HTTP ${res.status}: ${bodyText.slice(0, 140)}` : `SendGrid HTTP ${res.status}` };
  }
  const msgId = res.headers.get('x-message-id') || generateId('SG');
  return { ok: true, messageId: msgId };
}

async function sendViaEmailWebhook(
  config: AppConfig,
  toEmail: string,
  subject: string,
  textBody: string,
  htmlBody: string,
  transactionId?: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  if (!config.emailWebhookUrl) {
    return { ok: false, error: 'Email webhook URL missing.' };
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.emailWebhookBearerToken) {
    headers.Authorization = `Bearer ${config.emailWebhookBearerToken}`;
  }
  const res = await fetch(config.emailWebhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      channel: 'email',
      to: sanitizeHeaderValue(toEmail),
      from: config.emailFromAddress || config.gmailSmtpUser || 'noreply@meridiantrust.local',
      subject: sanitizeHeaderValue(subject),
      text: textBody,
      html: htmlBody,
      transactionId: transactionId ?? null,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string; error?: string };
  if (!res.ok) {
    return { ok: false, error: data.error || `Email Webhook HTTP ${res.status}` };
  }
  return { ok: true, messageId: data.messageId || data.id || generateId('EML-WHK') };
}

export async function dispatchTransactionEmail(
  db: Database.Database,
  config: AppConfig,
  input: EmailDispatchInput,
): Promise<EmailDispatchResult> {
  const id = generateId('notif');
  const now = new Date().toISOString();
  const masked = maskEmail(input.email);
  const activeAdapter = resolveActiveEmailAdapter(config);
  const liveProviderLabel = input.gmailAccessToken
    ? 'gmail_api'
    : activeAdapter === 'none'
      ? 'email_live'
      : activeAdapter;
  const providerName = input.gmailAccessToken || config.emailProviderMode === 'live' ? liveProviderLabel : 'email_sandbox';

  if (!input.emailOptIn) {
    db.prepare(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, created_at)
       VALUES (?, ?, ?, 'email', ?, ?, ?, 'skipped_opt_out', ?)`,
    ).run(id, input.userId, input.transactionId ?? null, masked, input.message, providerName, now);
    return { status: 'skipped_opt_out', notificationId: id, provider: providerName };
  }

  if (!input.email) {
    db.prepare(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
       VALUES (?, ?, ?, 'email', 'N/A', ?, ?, 'failed', 'No registered email or Gmail address', ?)`,
    ).run(id, input.userId, input.transactionId ?? null, input.message, providerName, now);
    return { status: 'failed', notificationId: id, provider: providerName, errorMessage: 'No registered email or Gmail address' };
  }

  if (input.simulateFailure || input.email.toLowerCase().startsWith('fail-alert@')) {
    const errText = 'Mail relay timeout (simulated failure)';
    db.prepare(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
       VALUES (?, ?, ?, 'email', ?, ?, ?, 'failed', ?, ?)`,
    ).run(id, input.userId, input.transactionId ?? null, masked, input.message, providerName, errText, now);
    return { status: 'failed', notificationId: id, provider: providerName, errorMessage: errText };
  }

  const html = input.htmlBody || buildDefaultHtml(input.subject, input.message);

  // Path 1: Explicit 1P Google Workspace Gmail API OAuth token from authorized client
  if (input.gmailAccessToken) {
    try {
      const outcome = await sendViaGmailWorkspaceApi(input.gmailAccessToken, input.email, input.subject, input.message);
      if (!outcome.ok) {
        db.prepare(
          `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
           VALUES (?, ?, ?, 'email', ?, ?, 'gmail_api', 'failed', ?, ?)`,
        ).run(id, input.userId, input.transactionId ?? null, masked, input.message, outcome.error, now);
        return { status: 'failed', notificationId: id, provider: 'gmail_api', errorMessage: outcome.error };
      }

      db.prepare(
        `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, provider_message_id, status, created_at)
         VALUES (?, ?, ?, 'email', ?, ?, 'gmail_api', ?, 'sent', ?)`,
      ).run(id, input.userId, input.transactionId ?? null, masked, input.message, outcome.messageId, now);
      return {
        status: 'sent',
        notificationId: id,
        provider: 'gmail_api',
        providerMessageId: outcome.messageId,
      };
    } catch (err) {
      const safeErr = err instanceof Error ? err.message.slice(0, 180) : 'Gmail API network error';
      db.prepare(
        `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
         VALUES (?, ?, ?, 'email', ?, ?, 'gmail_api', 'failed', ?, ?)`,
      ).run(id, input.userId, input.transactionId ?? null, masked, input.message, safeErr, now);
      return { status: 'failed', notificationId: id, provider: 'gmail_api', errorMessage: safeErr };
    }
  }

  // Path 2: Automated server-side Email / Gmail SMTP provider in live mode
  if (config.emailProviderMode === 'live') {
    if (!isEmailLiveConfigured(config)) {
      const errText = 'Live Email/Gmail SMTP provider credentials missing in server environment';
      db.prepare(
        `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
         VALUES (?, ?, ?, 'email', ?, ?, ?, 'failed', ?, ?)`,
      ).run(id, input.userId, input.transactionId ?? null, masked, input.message, liveProviderLabel, errText, now);
      return { status: 'failed', notificationId: id, provider: liveProviderLabel, errorMessage: errText };
    }

    try {
      let outcome: { ok: true; messageId: string } | { ok: false; error: string };
      if (activeAdapter === 'gmail_smtp') {
        outcome = await sendViaGmailSmtp(config, input.email, input.subject, input.message, html);
      } else if (activeAdapter === 'resend') {
        outcome = await sendViaResend(config, input.email, input.subject, input.message, html);
      } else if (activeAdapter === 'sendgrid') {
        outcome = await sendViaSendGrid(config, input.email, input.subject, input.message, html);
      } else {
        outcome = await sendViaEmailWebhook(config, input.email, input.subject, input.message, html, input.transactionId);
      }

      if (!outcome.ok) {
        db.prepare(
          `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
           VALUES (?, ?, ?, 'email', ?, ?, ?, 'failed', ?, ?)`,
        ).run(id, input.userId, input.transactionId ?? null, masked, input.message, liveProviderLabel, outcome.error, now);
        return { status: 'failed', notificationId: id, provider: liveProviderLabel, errorMessage: outcome.error };
      }

      db.prepare(
        `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, provider_message_id, status, created_at)
         VALUES (?, ?, ?, 'email', ?, ?, ?, ?, 'sent', ?)`,
      ).run(id, input.userId, input.transactionId ?? null, masked, input.message, liveProviderLabel, outcome.messageId, now);
      return {
        status: 'sent',
        notificationId: id,
        provider: liveProviderLabel,
        providerMessageId: outcome.messageId,
      };
    } catch (err) {
      const safeErr = err instanceof Error ? err.message.slice(0, 180) : 'Email provider network error';
      db.prepare(
        `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, status, error_message, created_at)
         VALUES (?, ?, ?, 'email', ?, ?, ?, 'failed', ?, ?)`,
      ).run(id, input.userId, input.transactionId ?? null, masked, input.message, liveProviderLabel, safeErr, now);
      return { status: 'failed', notificationId: id, provider: liveProviderLabel, errorMessage: safeErr };
    }
  }

  const sandboxMsgId = generateId('EML-SBX');
  db.prepare(
    `INSERT INTO notifications (id, user_id, transaction_id, channel, recipient_masked, message, provider, provider_message_id, status, created_at)
     VALUES (?, ?, ?, 'email', ?, ?, 'email_sandbox', ?, 'sandbox_logged', ?)`,
  ).run(id, input.userId, input.transactionId ?? null, masked, input.message, sandboxMsgId, now);

  return {
    status: 'sandbox_logged',
    notificationId: id,
    provider: 'email_sandbox',
    providerMessageId: sandboxMsgId,
  };
}

export async function dispatchTransactionNotifications(
  db: Database.Database,
  config: AppConfig,
  input: {
    userId: string;
    mobile: string | null;
    email: string | null;
    smsOptIn: boolean;
    emailOptIn: boolean;
    transactionId?: string;
    subject: string;
    message: string;
    gmailAccessToken?: string;
  },
): Promise<{ sms: SmsDispatchResult | null; email: EmailDispatchResult | null }> {
  const [smsSettled, emailSettled] = await Promise.allSettled([
    dispatchTransactionSms(db, config, {
      userId: input.userId,
      mobile: input.mobile,
      smsOptIn: input.smsOptIn,
      transactionId: input.transactionId,
      message: input.message,
    }),
    dispatchTransactionEmail(db, config, {
      userId: input.userId,
      email: input.email,
      emailOptIn: input.emailOptIn,
      transactionId: input.transactionId,
      subject: input.subject,
      message: input.message,
      gmailAccessToken: input.gmailAccessToken,
    }),
  ]);

  return {
    sms: smsSettled.status === 'fulfilled' ? smsSettled.value : null,
    email: emailSettled.status === 'fulfilled' ? emailSettled.value : null,
  };
}
