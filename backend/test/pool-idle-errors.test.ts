import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { logIdleClientErrors } from '../src/db/index.ts';
import {
  startTestDb,
  stopTestDb,
  TESTCONTAINER_BOOT_MS,
  type TestDb,
} from './helpers/test-db.ts';

describe('idle postgres client errors', () => {
  let testDb: TestDb | undefined;

  beforeAll(async () => {
    testDb = await startTestDb({ poolMax: 1, migrate: false });
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    await stopTestDb(testDb);
  });

  it('logs and recovers when Postgres terminates an idle pooled connection', async () => {
    if (!testDb) throw new Error('expected a test database');
    const { pool, container } = testDb;
    const warn = vi.fn();
    logIdleClientErrors(pool, { warn });

    const { rows } = await pool.query<{ pid: number }>(
      'select pg_backend_pid() as pid',
    );
    const pid = rows[0]?.pid;
    expect(pid).toBeDefined();

    const admin = new pg.Client({
      connectionString: container.getConnectionUri(),
    });
    await admin.connect();
    try {
      await admin.query('select pg_terminate_backend($1)', [pid]);
    } finally {
      await admin.end();
    }

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(warn.mock.calls[0]).toMatchObject([
      { err: { code: '57P01' } },
      'idle postgres client errored; pool discarded it',
    ]);

    const after = await pool.query<{ ok: number }>('select 1 as ok');
    expect(after.rows).toEqual([{ ok: 1 }]);
  });
});
