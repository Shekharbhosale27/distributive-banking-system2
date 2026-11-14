import path from 'node:path';

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  appUrl: string;
  dbPath: string;
  sessionSecret: string;
  qrSigningSecret: string;
  allowDevSeed: boolean;
  bootstrapManagerUsername: string;
  bootstrapManagerPassword: string;
  paymentProviderMode: 'sandbox' | 'live';
  paymentProviderBaseUrl: string;
  paymentProviderApiKey: string;
  paymentWebhookSecret: string;
  kycProviderMode: 'sandbox' | 'live';
  kycProviderBaseUrl: string;
  kycProviderApiKey: string;
  smsProviderMode: 'sandbox' | 'live';
  smsProvider: 'auto' | 'twilio' | 'msg91' | 'fast2sms' | 'webhook';
  smsProviderAccountSid: string;
  smsProviderAuthToken: string;
  smsProviderFromNumber: string;
  msg91AuthKey: string;
  msg91TemplateId: string;
  msg91SenderId: string;
  fast2smsApiKey: string;
  smsWebhookUrl: string;
  smsWebhookBearerToken: string;
  emailProviderMode: 'sandbox' | 'live';
  emailProvider: 'auto' | 'gmail_smtp' | 'resend' | 'sendgrid' | 'webhook';
  emailFromAddress: string;
  emailFromName: string;
  gmailSmtpUser: string;
  gmailSmtpAppPassword: string;
  resendApiKey: string;
  sendgridApiKey: string;
  emailWebhookUrl: string;
  emailWebhookBearerToken: string;
  employeeMaxAdjustmentPaise: number;
  sessionTtlHours: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const smsProviderRaw = (process.env.SMS_PROVIDER || 'auto').toLowerCase();
  const smsProvider: AppConfig['smsProvider'] =
    smsProviderRaw === 'twilio' || smsProviderRaw === 'msg91' || smsProviderRaw === 'fast2sms' || smsProviderRaw === 'webhook'
      ? smsProviderRaw
      : 'auto';

  const emailProviderRaw = (process.env.EMAIL_PROVIDER || 'auto').toLowerCase();
  const emailProvider: AppConfig['emailProvider'] =
    emailProviderRaw === 'gmail_smtp' || emailProviderRaw === 'resend' || emailProviderRaw === 'sendgrid' || emailProviderRaw === 'webhook'
      ? emailProviderRaw
      : 'auto';

  return {
    nodeEnv,
    isProduction,
    port: Number(process.env.PORT || 3000),
    appUrl: process.env.APP_URL || 'http://localhost:3000',
    dbPath: process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'meridian_bank.db'),
    sessionSecret: process.env.SESSION_SECRET || 'dev-session-secret-not-for-production',
    qrSigningSecret: process.env.QR_SIGNING_SECRET || 'dev-qr-signing-secret-not-for-production',
    allowDevSeed: !isProduction && process.env.ALLOW_DEV_SEED !== 'false',
    bootstrapManagerUsername: process.env.BOOTSTRAP_MANAGER_USERNAME || '',
    bootstrapManagerPassword: process.env.BOOTSTRAP_MANAGER_PASSWORD || '',
    paymentProviderMode: process.env.PAYMENT_PROVIDER_MODE === 'live' ? 'live' : 'sandbox',
    paymentProviderBaseUrl: process.env.PAYMENT_PROVIDER_BASE_URL || '',
    paymentProviderApiKey: process.env.PAYMENT_PROVIDER_API_KEY || '',
    paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || 'dev-webhook-secret-change-in-production',
    kycProviderMode: process.env.KYC_PROVIDER_MODE === 'live' ? 'live' : 'sandbox',
    kycProviderBaseUrl: process.env.KYC_PROVIDER_BASE_URL || '',
    kycProviderApiKey: process.env.KYC_PROVIDER_API_KEY || '',
    smsProviderMode: process.env.SMS_PROVIDER_MODE === 'live' ? 'live' : 'sandbox',
    smsProvider,
    smsProviderAccountSid: process.env.SMS_PROVIDER_ACCOUNT_SID || '',
    smsProviderAuthToken: process.env.SMS_PROVIDER_AUTH_TOKEN || '',
    smsProviderFromNumber: process.env.SMS_PROVIDER_FROM_NUMBER || 'MRDBNK',
    msg91AuthKey: process.env.MSG91_AUTH_KEY || '',
    msg91TemplateId: process.env.MSG91_TEMPLATE_ID || '',
    msg91SenderId: process.env.MSG91_SENDER_ID || 'MRDBNK',
    fast2smsApiKey: process.env.FAST2SMS_API_KEY || '',
    smsWebhookUrl: process.env.SMS_WEBHOOK_URL || '',
    smsWebhookBearerToken: process.env.SMS_WEBHOOK_BEARER_TOKEN || '',
    emailProviderMode: process.env.EMAIL_PROVIDER_MODE === 'live' ? 'live' : 'sandbox',
    emailProvider,
    emailFromAddress: process.env.EMAIL_FROM_ADDRESS || process.env.GMAIL_SMTP_USER || '',
    emailFromName: process.env.EMAIL_FROM_NAME || 'Meridian Trust Bank',
    gmailSmtpUser: process.env.GMAIL_SMTP_USER || '',
    gmailSmtpAppPassword: process.env.GMAIL_SMTP_APP_PASSWORD || '',
    resendApiKey: process.env.RESEND_API_KEY || '',
    sendgridApiKey: process.env.SENDGRID_API_KEY || '',
    emailWebhookUrl: process.env.EMAIL_WEBHOOK_URL || '',
    emailWebhookBearerToken: process.env.EMAIL_WEBHOOK_BEARER_TOKEN || '',
    employeeMaxAdjustmentPaise: Number(process.env.EMPLOYEE_MAX_ADJUSTMENT_PAISE || 2_500_000),
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
    ...overrides,
  };
}
