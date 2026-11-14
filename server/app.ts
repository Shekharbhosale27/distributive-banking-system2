import express from 'express';
import type Database from 'better-sqlite3';
import { AppConfig } from './config.ts';
import { createAuthMiddleware, securityHeadersMiddleware } from './middleware/security.ts';
import { resolveActiveEmailAdapter } from './providers/emailProvider.ts';
import { resolveActiveSmsAdapter } from './providers/smsProvider.ts';
import { buildOpenApiSpec, renderApiDocsHtml } from './openapi.ts';
import { createAuthRouter } from './routes/authRoutes.ts';
import { createCustomerRouter } from './routes/customerRoutes.ts';
import { createEmployeeRouter } from './routes/employeeRoutes.ts';
import { createManagerRouter, createWebhookRouter } from './routes/managerRoutes.ts';

export function createBankApp(params: { db: Database.Database; config: AppConfig }) {
  const { db, config } = params;
  const app = express();

  app.set('trust proxy', 1);
  app.use(securityHeadersMiddleware);
  app.use(express.json({ limit: '1mb' }));
  app.use(createAuthMiddleware(db));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      environment: config.nodeEnv,
      providers: {
        payment: config.paymentProviderMode,
        kyc: config.kycProviderMode,
        sms: config.smsProviderMode,
        smsAdapter: resolveActiveSmsAdapter(config),
        email: config.emailProviderMode,
        emailAdapter: resolveActiveEmailAdapter(config),
      },
      devSeedEnabled: config.allowDevSeed,
    });
  });

  app.get('/api/openapi.json', (_req, res) => {
    res.json(buildOpenApiSpec(config.appUrl));
  });

  app.get('/api/docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderApiDocsHtml());
  });

  app.use('/api/auth', createAuthRouter(db, config));
  app.use('/api', createCustomerRouter(db, config));
  app.use('/api/employee', createEmployeeRouter(db, config));
  app.use('/api/manager', createManagerRouter(db, config));
  app.use('/api/webhooks', createWebhookRouter(db, config));

  // Unmatched API routes return structured JSON 404
  app.use('/api/*', (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'API endpoint not found.' });
  });

  return app;
}
