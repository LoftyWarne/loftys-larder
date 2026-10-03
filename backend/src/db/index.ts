import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';

import { loadConfig } from '../config.ts';
import * as schema from './schema/index.ts';
import {
  makeWithTransaction,
  type WithTransaction,
} from './withTransaction.ts';

// Pool max committed at 10 in docs/measurements.md (FEAT-08). Revisit triggers
// in DEC-71. `min` left at pg-pool's default (0) so cold-start cost stays on
// the Node + Fastify boot path (cross-cutting concern #18).
const POOL_MAX = 10;

type Schema = typeof schema;

export type Db = NodePgDatabase<Schema>;

interface DbSingleton {
  pool: pg.Pool;
  db: Db;
  withTransaction: WithTransaction;
}

let singleton: DbSingleton | undefined;

// Lazy so importing this module is side-effect-free: tests that only need
// `makeWithTransaction` or schema metadata don't need the production env vars
// set, and the pool only opens when something actually wants the singleton.
export function getDb(log: Pick<FastifyBaseLogger, 'warn'>): DbSingleton {
  if (singleton) return singleton;
  const config = loadConfig();
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: POOL_MAX,
  });
  logIdleClientErrors(pool, log);
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  singleton = { pool, db, withTransaction: makeWithTransaction(db) };
  return singleton;
}

// pg-pool re-emits an idle client's error (e.g. Postgres restarting and
// terminating its connections) on the pool. With no listener Node treats it as
// an uncaught exception and the process exits. The pool has already discarded
// the client and reconnects on the next checkout, so logging is enough.
export function logIdleClientErrors(
  pool: pg.Pool,
  log: Pick<FastifyBaseLogger, 'warn'>,
): void {
  pool.on('error', (err) => {
    log.warn({ err }, 'idle postgres client errored; pool discarded it');
  });
}

export { CURRENT_HOUSEHOLD_ID } from '../config.ts';
