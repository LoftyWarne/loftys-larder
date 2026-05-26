import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
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
export function getDb(): DbSingleton {
  if (singleton) return singleton;
  const config = loadConfig();
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: POOL_MAX,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  singleton = { pool, db, withTransaction: makeWithTransaction(db) };
  return singleton;
}

export { CURRENT_HOUSEHOLD_ID } from '../config.ts';
