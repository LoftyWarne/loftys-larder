import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema/index.ts';
import { makeWithTransaction } from '../src/db/withTransaction.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;

describe('db smoke', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.2-alpine').start();
    pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      max: 1,
    });
    db = drizzle(pool, { schema, casing: 'snake_case' });
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it('constructs a Drizzle instance against a real Postgres', () => {
    expect(db).toBeDefined();
    expect(typeof db.execute).toBe('function');
    expect(typeof db.transaction).toBe('function');
  });

  it('round-trips a `select 1` query', async () => {
    const result = await db.execute<{ one: number }>(sql`select 1 as one`);
    expect(result.rows).toEqual([{ one: 1 }]);
  });

  it('withTransaction commits when the callback resolves', async () => {
    const withTransaction = makeWithTransaction(db);

    await db.execute(sql`drop table if exists tx_commit_probe`);
    await db.execute(sql`create table tx_commit_probe (id int primary key)`);

    await withTransaction(async (tx) => {
      await tx.execute(sql`insert into tx_commit_probe (id) values (1)`);
    });

    const after = await db.execute<{ id: number }>(
      sql`select id from tx_commit_probe`,
    );
    expect(after.rows).toEqual([{ id: 1 }]);

    await db.execute(sql`drop table tx_commit_probe`);
  });

  it('withTransaction rolls back when the callback throws', async () => {
    const withTransaction = makeWithTransaction(db);

    await db.execute(sql`drop table if exists tx_rollback_probe`);
    await db.execute(sql`create table tx_rollback_probe (id int primary key)`);

    await expect(
      withTransaction(async (tx) => {
        await tx.execute(sql`insert into tx_rollback_probe (id) values (1)`);
        throw new Error('intentional rollback');
      }),
    ).rejects.toThrow('intentional rollback');

    const after = await db.execute<{ id: number }>(
      sql`select id from tx_rollback_probe`,
    );
    expect(after.rows).toEqual([]);

    await db.execute(sql`drop table tx_rollback_probe`);
  });

  it('releases pool connections between sequential queries beyond pool max', async () => {
    // Pool max is 1 here; running more sequential queries than that exercises
    // the release-back-to-pool path. A leaked client would hang on the second.
    for (let i = 0; i < 5; i++) {
      const result = await db.execute<{ ok: number }>(sql`select 1 as ok`);
      expect(result.rows).toEqual([{ ok: 1 }]);
    }
  });
});
