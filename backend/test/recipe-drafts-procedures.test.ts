import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import {
  accounts,
  sessions,
  users,
  verifications,
} from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import { recipeDrafts } from '../src/db/schema/recipe-drafts.ts';
import { recipes } from '../src/db/schema/recipes.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { appRouter } from '../src/trpc/router.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const USER_ID = 'user-drafts-test-1';
const OTHER_USER_ID = 'user-drafts-test-2';
const USER_EMAIL = 'dtest@example.com';
const OTHER_USER_EMAIL = 'dtest2@example.com';
const SESSION_ID = 'session-drafts-test-1';

describe('recipe drafts procedures', () => {
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
      truncate table
        ${recipeDrafts},
        ${recipes},
        ${households},
        ${users},
        ${sessions},
        ${accounts},
        ${verifications}
      restart identity cascade
    `);
    await db
      .insert(households)
      .values([{ id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" }]);
    await db.insert(users).values([
      {
        id: USER_ID,
        email: USER_EMAIL,
        name: 'Draft Tester',
        emailVerified: true,
      },
      {
        id: OTHER_USER_ID,
        email: OTHER_USER_EMAIL,
        name: 'Other Tester',
        emailVerified: true,
      },
    ]);
  });

  function makeContext(
    overrides: { authenticated?: boolean; userId?: string } = {},
  ): AppContext {
    const authenticated = overrides.authenticated ?? true;
    const userId = overrides.userId ?? USER_ID;
    return {
      req: {} as AppContext['req'],
      reply: {} as AppContext['reply'],
      reqId: 'rid-test',
      db,
      cloudinary: {
        cloudName: 'test-cloud',
        apiKey: 'test-key',
        apiSecret: 'test-secret',
      },
      session: authenticated
        ? {
            id: SESSION_ID,
            userId,
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
            id: userId,
            email: userId === USER_ID ? USER_EMAIL : OTHER_USER_EMAIL,
            name: 'Tester',
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

  async function insertRecipe(name: string): Promise<number> {
    const inserted = await db
      .insert(recipes)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name,
        baseServings: 2,
        addedByUserId: USER_ID,
      })
      .returning({ id: recipes.id });
    const row = inserted[0];
    if (!row) throw new Error('recipe insert failed');
    return row.id;
  }

  function envelope(fields: Record<string, unknown>) {
    return { version: 1 as const, fields };
  }

  describe('upsert', () => {
    it('inserts a draft for a recipe when none exists', async () => {
      const recipeId = await insertRecipe('Pasta');
      const caller = createCaller(makeContext());

      const result = await caller.recipeDrafts.upsert({
        recipeId,
        draftData: envelope({ header: { name: 'Pasta in progress' } }),
      });

      expect(result.id).toBeGreaterThan(0);
      expect(result.lastUpdatedAt).toBeGreaterThan(0);

      const rows = await db
        .select()
        .from(recipeDrafts)
        .where(
          and(
            eq(recipeDrafts.userId, USER_ID),
            eq(recipeDrafts.recipeId, recipeId),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.draftData).toEqual({
        version: 1,
        fields: { header: { name: 'Pasta in progress' } },
      });
    });

    it('updates the draft when called again for the same recipe', async () => {
      const recipeId = await insertRecipe('Pasta');
      const caller = createCaller(makeContext());

      const first = await caller.recipeDrafts.upsert({
        recipeId,
        draftData: envelope({ header: { name: 'Draft 1' } }),
      });
      const second = await caller.recipeDrafts.upsert({
        recipeId,
        draftData: envelope({ header: { name: 'Draft 2' } }),
      });

      expect(second.id).toBe(first.id);

      const rows = await db.select().from(recipeDrafts);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.draftData).toEqual({
        version: 1,
        fields: { header: { name: 'Draft 2' } },
      });
    });

    it('rejects payloads with the wrong envelope version', async () => {
      const recipeId = await insertRecipe('Pasta');
      const caller = createCaller(makeContext());

      await expect(
        caller.recipeDrafts.upsert({
          recipeId,
          draftData: { version: 99, fields: {} } as never,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('creates separate rows for two new-recipe drafts (NULL distinct)', async () => {
      const caller = createCaller(makeContext());

      const a = await caller.recipeDrafts.upsert({
        recipeId: null,
        draftData: envelope({ header: { name: 'New A' } }),
      });
      const b = await caller.recipeDrafts.upsert({
        recipeId: null,
        draftData: envelope({ header: { name: 'New B' } }),
      });

      expect(a.id).not.toBe(b.id);
      const rows = await db.select().from(recipeDrafts);
      expect(rows).toHaveLength(2);
    });

    it('updates the targeted draft when draftId is provided (new-recipe slot)', async () => {
      const caller = createCaller(makeContext());

      const first = await caller.recipeDrafts.upsert({
        recipeId: null,
        draftData: envelope({ header: { name: 'New A' } }),
      });
      const second = await caller.recipeDrafts.upsert({
        draftId: first.id,
        recipeId: null,
        draftData: envelope({ header: { name: 'New A — updated' } }),
      });

      expect(second.id).toBe(first.id);
      const rows = await db.select().from(recipeDrafts);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.draftData).toEqual({
        version: 1,
        fields: { header: { name: 'New A — updated' } },
      });
    });

    it('returns NOT_FOUND when draftId belongs to another user', async () => {
      const otherCaller = createCaller(makeContext({ userId: OTHER_USER_ID }));
      const theirs = await otherCaller.recipeDrafts.upsert({
        recipeId: null,
        draftData: envelope({}),
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.recipeDrafts.upsert({
          draftId: theirs.id,
          recipeId: null,
          draftData: envelope({ header: { name: 'Hijack' } }),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects unauthenticated callers', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.recipeDrafts.upsert({
          recipeId: null,
          draftData: envelope({}),
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('getForRecipe', () => {
    it('returns the caller’s draft for the recipe', async () => {
      const recipeId = await insertRecipe('Pasta');
      const caller = createCaller(makeContext());
      await caller.recipeDrafts.upsert({
        recipeId,
        draftData: envelope({ header: { name: 'Hello' } }),
      });

      const result = await caller.recipeDrafts.getForRecipe({ recipeId });
      expect(result?.draftData.fields).toEqual({ header: { name: 'Hello' } });
    });

    it('returns null when no draft exists', async () => {
      const recipeId = await insertRecipe('Pasta');
      const caller = createCaller(makeContext());
      const result = await caller.recipeDrafts.getForRecipe({ recipeId });
      expect(result).toBeNull();
    });

    it('does not return another user’s draft', async () => {
      const recipeId = await insertRecipe('Pasta');
      const otherCaller = createCaller(makeContext({ userId: OTHER_USER_ID }));
      await otherCaller.recipeDrafts.upsert({
        recipeId,
        draftData: envelope({ header: { name: 'Theirs' } }),
      });

      const caller = createCaller(makeContext());
      const result = await caller.recipeDrafts.getForRecipe({ recipeId });
      expect(result).toBeNull();
    });

    it('drops drafts with a mismatched envelope version', async () => {
      const recipeId = await insertRecipe('Pasta');
      // Inject a row with version 0 directly — the procedure must drop it.
      await db.insert(recipeDrafts).values({
        userId: USER_ID,
        recipeId,
        draftData: { version: 0, fields: { header: { name: 'Old' } } },
      });

      const caller = createCaller(makeContext());
      const result = await caller.recipeDrafts.getForRecipe({ recipeId });
      expect(result).toBeNull();
    });

    it('rejects unauthenticated callers', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.recipeDrafts.getForRecipe({ recipeId: 1 }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('getNewDrafts', () => {
    it('returns only the caller’s recipe_id IS NULL drafts, newest first', async () => {
      const caller = createCaller(makeContext());
      const otherCaller = createCaller(makeContext({ userId: OTHER_USER_ID }));
      await otherCaller.recipeDrafts.upsert({
        recipeId: null,
        draftData: envelope({ header: { name: 'Theirs' } }),
      });
      await caller.recipeDrafts.upsert({
        recipeId: null,
        draftData: envelope({ header: { name: 'Older' } }),
      });
      // Force an ordering gap so the newer row sorts above.
      await db.execute(sql`select pg_sleep(0.01)`);
      await caller.recipeDrafts.upsert({
        recipeId: null,
        draftData: envelope({ header: { name: 'Newer' } }),
      });

      const result = await caller.recipeDrafts.getNewDrafts();
      expect(result.map((d) => d.draftData.fields)).toEqual([
        { header: { name: 'Newer' } },
        { header: { name: 'Older' } },
      ]);
    });

    it('omits drafts with mismatched envelope version', async () => {
      await db.insert(recipeDrafts).values({
        userId: USER_ID,
        recipeId: null,
        draftData: { version: 0, fields: {} },
      });
      const caller = createCaller(makeContext());
      const result = await caller.recipeDrafts.getNewDrafts();
      expect(result).toEqual([]);
    });

    it('rejects unauthenticated callers', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(caller.recipeDrafts.getNewDrafts()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('delete', () => {
    it('deletes the caller’s draft for the recipe', async () => {
      const recipeId = await insertRecipe('Pasta');
      const caller = createCaller(makeContext());
      await caller.recipeDrafts.upsert({
        recipeId,
        draftData: envelope({}),
      });

      const result = await caller.recipeDrafts.delete({ recipeId });
      expect(result).toEqual({ deleted: true });

      const rows = await db.select().from(recipeDrafts);
      expect(rows).toHaveLength(0);
    });

    it('reports deleted=false when no row matched', async () => {
      const recipeId = await insertRecipe('Pasta');
      const caller = createCaller(makeContext());
      const result = await caller.recipeDrafts.delete({ recipeId });
      expect(result).toEqual({ deleted: false });
    });

    it('does not delete another user’s draft', async () => {
      const recipeId = await insertRecipe('Pasta');
      const otherCaller = createCaller(makeContext({ userId: OTHER_USER_ID }));
      await otherCaller.recipeDrafts.upsert({
        recipeId,
        draftData: envelope({}),
      });

      const caller = createCaller(makeContext());
      const result = await caller.recipeDrafts.delete({ recipeId });
      expect(result).toEqual({ deleted: false });

      const rows = await db.select().from(recipeDrafts);
      expect(rows).toHaveLength(1);
    });

    it('deletes all of the caller’s new-recipe drafts when recipeId is null', async () => {
      const caller = createCaller(makeContext());
      await caller.recipeDrafts.upsert({
        recipeId: null,
        draftData: envelope({ header: { name: 'A' } }),
      });
      await caller.recipeDrafts.upsert({
        recipeId: null,
        draftData: envelope({ header: { name: 'B' } }),
      });

      const result = await caller.recipeDrafts.delete({ recipeId: null });
      expect(result).toEqual({ deleted: true });

      const rows = await db.select().from(recipeDrafts);
      expect(rows).toHaveLength(0);
    });

    it('rejects unauthenticated callers', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.recipeDrafts.delete({ recipeId: null }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });
});
