import 'dotenv/config';
import { loadConfig } from '../config.ts';
import { openDatabase, runMigrations, seedDatabase } from './database.ts';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const applied = runMigrations(db);
seedDatabase(db, config);
console.log(JSON.stringify({ dbPath: config.dbPath, appliedMigrations: applied, devSeedEnabled: config.allowDevSeed }));
db.close();
