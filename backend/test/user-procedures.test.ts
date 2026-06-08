import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema/index.ts';
import {
  accounts,
  sessions,
  users,
  verifications,
} from '../src/db/schema/auth.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { appRouter } from '../src/trpc/router.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const USER_ID = 'user-test-1';
const USER_EMAIL = 'tester@example.com';
const OTHER_USER_ID = 'user-test-2';
const SESSION_ID = 'session-test-1';

describe('user procedures', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.2-alpine').start();
    pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      max: 4,
    });
    db = drizzle(pool, { schema, casing: 'snake_case' });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await db.execute(sql`
      truncate table ${users}, ${sessions}, ${accounts}, ${verifications}
      restart identity cascade
    `);
    await db.insert(users).values({
      id: USER_ID,
      email: USER_EMAIL,
      name: 'Test User',
      emailVerified: true,
    });
  });

  function makeContext(
    overrides: { authenticated?: boolean } = {},
  ): AppContext {
    const authenticated = overrides.authenticated ?? true;
    return {
      req: {} as AppContext['req'],
      reply: {} as AppContext['reply'],
      reqId: 'rid-test',
      db,
      session: authenticated
        ? {
            id: SESSION_ID,
            userId: USER_ID,
            token: 'tok',
            expiresAt: new Date(Date.now() + 60_000),
            ipAddress: null,
            userAgent: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
      user: authenticated
        ? {
            id: USER_ID,
            email: USER_EMAIL,
            name: 'Test User',
            emailVerified: true,
            image: null,
            themePreference: 'system',
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
    };
  }

  const createCaller = appRouter.createCaller;

  describe('getMe', () => {
    it('returns the authenticated user profile', async () => {
      const caller = createCaller(makeContext());
      const me = await caller.user.getMe();
      expect(me).toEqual({
        id: USER_ID,
        email: USER_EMAIL,
        name: 'Test User',
        themePreference: 'system',
      });
    });

    it('rejects without a session', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(caller.user.getMe()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('updateProfile', () => {
    it('updates name only and leaves themePreference untouched', async () => {
      const caller = createCaller(makeContext());
      const me = await caller.user.updateProfile({ name: 'New Name' });
      expect(me.name).toBe('New Name');
      expect(me.themePreference).toBe('system');

      const fresh = await db.select().from(users).where(eq(users.id, USER_ID));
      expect(fresh[0]?.name).toBe('New Name');
      expect(fresh[0]?.themePreference).toBe('system');
    });

    it('updates themePreference only and leaves name untouched', async () => {
      const caller = createCaller(makeContext());
      const me = await caller.user.updateProfile({ themePreference: 'dark' });
      expect(me.name).toBe('Test User');
      expect(me.themePreference).toBe('dark');

      const fresh = await db.select().from(users).where(eq(users.id, USER_ID));
      expect(fresh[0]?.themePreference).toBe('dark');
    });

    it('rejects empty / whitespace-only name', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.user.updateProfile({ name: '   ' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects an unknown themePreference value', async () => {
      const caller = createCaller(makeContext());
      type Input = Parameters<typeof caller.user.updateProfile>[0];
      const bad = { themePreference: 'sepia' } as unknown as Input;
      await expect(caller.user.updateProfile(bad)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('rejects when neither field is provided', async () => {
      const caller = createCaller(makeContext());
      await expect(caller.user.updateProfile({})).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('rejects without a session', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.user.updateProfile({ name: 'Anything' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('bumps updatedAt via $onUpdate', async () => {
      const before = await db
        .select({ updatedAt: users.updatedAt })
        .from(users)
        .where(eq(users.id, USER_ID));
      const initial = before[0]?.updatedAt.getTime() ?? 0;

      await new Promise((r) => setTimeout(r, 20));

      const caller = createCaller(makeContext());
      await caller.user.updateProfile({ themePreference: 'light' });

      const after = await db
        .select({ updatedAt: users.updatedAt })
        .from(users)
        .where(eq(users.id, USER_ID));
      expect(after[0]?.updatedAt.getTime() ?? 0).toBeGreaterThan(initial);
    });

    it('scopes the update to the authenticated user', async () => {
      await db.insert(users).values({
        id: OTHER_USER_ID,
        email: 'other@example.com',
        name: 'Other User',
        emailVerified: true,
      });

      const caller = createCaller(makeContext());
      await caller.user.updateProfile({ name: 'Renamed' });

      const other = await db
        .select()
        .from(users)
        .where(eq(users.id, OTHER_USER_ID));
      expect(other[0]?.name).toBe('Other User');
    });
  });
});
