import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type {
  NodePgDatabase,
  NodePgQueryResultHKT,
} from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';

import type * as schema from './schema/index.ts';

type Schema = typeof schema;

export type Tx = PgTransaction<
  NodePgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

export type WithTransaction = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

// Wraps Drizzle's underlying `db.transaction(...)` so domain code never reaches
// for it directly (cross-cutting concern #4). Audit-grep for `db.transaction(`
// — this file should be the only hit.
export function makeWithTransaction(
  db: NodePgDatabase<Schema>,
): WithTransaction {
  return (fn) => db.transaction(fn);
}
