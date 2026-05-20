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

const config = loadConfig();

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: POOL_MAX,
});

export const db: Db = drizzle(pool, { schema, casing: 'snake_case' });

export const withTransaction: WithTransaction = makeWithTransaction(db);

export { CURRENT_HOUSEHOLD_ID } from '../config.ts';
