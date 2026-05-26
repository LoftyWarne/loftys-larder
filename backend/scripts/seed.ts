import { pino } from 'pino';

import { getDb } from '../src/db/index.ts';

const { pool, withTransaction } = getDb();
import { runSeeds } from '../src/db/seeds/index.ts';

// CLI entry. Domain code uses Fastify's request logger; this script lives
// outside that lifecycle, so a small standalone Pino instance is fine
// (AGENTS.md "Pino only; no `console.log`").
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<void> {
  log.info('seed: starting');
  await runSeeds(withTransaction);
  log.info('seed: complete');
}

try {
  await main();
} catch (err) {
  log.error({ err }, 'seed: failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
