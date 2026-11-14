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
  smsProviderFromNumber: string;
  employeeMaxAdjustmentPaise: number;
  sessionTtlHours: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

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
    smsProviderFromNumber: process.env.SMS_PROVIDER_FROM_NUMBER || 'MRDBNK',
    employeeMaxAdjustmentPaise: Number(process.env.EMPLOYEE_MAX_ADJUSTMENT_PAISE || 2_500_000),
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
    ...overrides,
  };
}
