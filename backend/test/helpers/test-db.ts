import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import type { Db } from '../../src/db/index.ts';
import * as schema from '../../src/db/schema/index.ts';

export const TESTCONTAINER_BOOT_MS = 120_000;
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);

export interface TestDb {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  db: Db;
}

export async function startTestDb(options: {
  poolMax: number;
  migrate?: boolean;
}): Promise<TestDb> {
  const container = await new PostgreSqlContainer(
    'postgres:17.2-alpine',
  ).start();
  const pool = new pg.Pool({
    connectionString: container.getConnectionUri(),
    max: options.poolMax,
  });
  const testDb: TestDb = {
    container,
    pool,
    db: drizzle(pool, { schema, casing: 'snake_case' }),
  };
  if (options.migrate ?? true) {
    try {
      await migrate(testDb.db, { migrationsFolder: MIGRATIONS_DIR });
    } catch (error) {
      await stopTestDb(testDb);
      throw error;
    }
  }
  return testDb;
}

export async function stopTestDb(testDb: TestDb | undefined): Promise<void> {
  if (!testDb) return;
  // pool.end() resolves before its clients finish closing, so stopping the
  // container can hit a closing client with FATAL 57P01. pg-pool re-emits that
  // on the pool, and with no listener Node makes it an uncaught exception that
  // fails the Vitest run. Attached only here so idle-client errors mid-run
  // still surface.
  testDb.pool.on('error', () => undefined);
  await testDb.pool.end();
  await testDb.container.stop();
}
