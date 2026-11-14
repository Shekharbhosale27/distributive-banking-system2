import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { loadConfig } from './server/config.ts';
import { openDatabase, runMigrations, seedDatabase } from './server/db/database.ts';
import { createBankApp } from './server/app.ts';

async function startServer() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  runMigrations(db);
  seedDatabase(db, config);

  const app = createBankApp({ db, config });

  if (!config.isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Meridian Trust Bank server listening on http://0.0.0.0:${config.port} (${config.nodeEnv})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Meridian Trust Bank server:', err);
  process.exit(1);
});
