import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { pino } from 'pino';

import { databaseUrlSchema } from './config.ts';
import * as schema from './db/schema/index.ts';
import { runReferenceSeeds } from './db/seeds/index.ts';
import { makeWithTransaction } from './db/withTransaction.ts';

// Standalone reference-seed entrypoint, bundled to dist/seed-reference.js and
// run after migrate.js in the Fly release_command (see fly.toml). Populates the
// global lookup tables (units, prep types, ingredient categories, meal
// occasions) so production has them without a UI to edit them. Idempotent via
// `ON CONFLICT DO NOTHING`, so re-running on every deploy is a no-op once seeded.
//
// Mirrors migrate.ts: parses only DATABASE_URL (keeping release-machine env
// requirements minimal) and uses a fresh max:1 pool. This script lives outside
// the Fastify lifecycle, so a small standalone Pino instance is used
// (AGENTS.md "Pino only; no `console.log`").
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const databaseUrl = databaseUrlSchema.parse(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const db = drizzle(pool, { schema, casing: 'snake_case' });
const withTransaction = makeWithTransaction(db);

try {
  log.info('seed-reference: starting');
  await runReferenceSeeds(withTransaction);
  log.info('seed-reference: complete');
} catch (err) {
  log.error({ err }, 'seed-reference: failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
