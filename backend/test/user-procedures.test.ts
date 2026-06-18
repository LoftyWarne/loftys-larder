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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import {
  accounts,
  sessions,
  users,
  verifications,
} from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import { mealPlans, mealPlanSlots } from '../src/db/schema/meal-plans.ts';
import { recipeDrafts } from '../src/db/schema/recipe-drafts.ts';
import {
  recipeComments,
  recipeRatings,
} from '../src/db/schema/recipe-social.ts';
import { recipes } from '../src/db/schema/recipes.ts';
import { mealOccasions } from '../src/db/schema/reference.ts';
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
      truncate table
        ${recipeRatings},
        ${recipeComments},
        ${recipeDrafts},
        ${mealPlanSlots},
        ${mealPlans},
        ${recipes},
        ${mealOccasions},
        ${households},
        ${users},
        ${sessions},
        ${accounts},
        ${verifications}
      restart identity cascade
    `);
    await db
      .insert(households)
      .values({ id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" });
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
      cloudinary: {
        cloudName: 'test-cloud',
        apiKey: 'test-key',
        apiSecret: 'test-secret',
      },
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

  describe('listHouseholdMembers', () => {
    it('returns the seeded user as a member', async () => {
      const caller = createCaller(makeContext());
      const result = await caller.user.listHouseholdMembers();
      expect(result.members).toEqual([
        { id: USER_ID, name: 'Test User', email: USER_EMAIL },
      ]);
    });

    it('returns members ordered by name', async () => {
      await db.insert(users).values([
        {
          id: OTHER_USER_ID,
          email: 'other@example.com',
          name: 'Alice',
          emailVerified: true,
        },
        {
          id: 'user-test-3',
          email: 'third@example.com',
          name: 'Zara',
          emailVerified: true,
        },
      ]);

      const caller = createCaller(makeContext());
      const result = await caller.user.listHouseholdMembers();
      expect(result.members.map((m) => m.name)).toEqual([
        'Alice',
        'Test User',
        'Zara',
      ]);
    });

    it('rejects without a session', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(caller.user.listHouseholdMembers()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  async function insertRecipe(
    name: string,
    options: { addedByUserId?: string | null; isDeleted?: boolean } = {},
  ): Promise<number> {
    const inserted = await db
      .insert(recipes)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name,
        baseServings: 2,
        addedByUserId: options.addedByUserId ?? USER_ID,
        isDeleted: options.isDeleted ?? false,
      })
      .returning({ id: recipes.id });
    const row = inserted[0];
    if (!row) throw new Error('recipe insert failed');
    return row.id;
  }

  async function insertPlan(createdByUserId: string | null): Promise<number> {
    const start = new Date('2026-06-01');
    const end = new Date('2026-06-07');
    const inserted = await db
      .insert(mealPlans)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        createdByUserId,
        startDate: start,
        endDate: end,
      })
      .returning({ id: mealPlans.id });
    const row = inserted[0];
    if (!row) throw new Error('plan insert failed');
    return row.id;
  }

  async function insertOccasion(name: string): Promise<number> {
    const rows = await db
      .insert(mealOccasions)
      .values({ name })
      .returning({ id: mealOccasions.id });
    const row = rows[0];
    if (!row) throw new Error('occasion insert failed');
    return row.id;
  }

  async function seedOtherUser(): Promise<void> {
    await db.insert(users).values({
      id: OTHER_USER_ID,
      email: 'other@example.com',
      name: 'Other User',
      emailVerified: true,
    });
  }

  describe('getDeletionSummary', () => {
    it('returns zero counts for a user with no household activity', async () => {
      const caller = createCaller(makeContext());
      const summary = await caller.user.getDeletionSummary();
      expect(summary).toEqual({
        commentCount: 0,
        recipeCount: 0,
        planCount: 0,
      });
    });

    it('counts the user’s comments, non-deleted recipes, and plans', async () => {
      const recipeA = await insertRecipe('Recipe A');
      await insertRecipe('Recipe B');
      await insertRecipe('Soft-deleted', { isDeleted: true });
      await insertPlan(USER_ID);
      await insertPlan(USER_ID);

      await db.insert(recipeComments).values([
        { recipeId: recipeA, userId: USER_ID, comment: 'one' },
        { recipeId: recipeA, userId: USER_ID, comment: 'two' },
        { recipeId: recipeA, userId: USER_ID, comment: 'three' },
      ]);

      const caller = createCaller(makeContext());
      const summary = await caller.user.getDeletionSummary();
      expect(summary).toEqual({
        commentCount: 3,
        recipeCount: 2,
        planCount: 2,
      });
    });

    it('excludes records belonging to other users', async () => {
      await seedOtherUser();
      const theirRecipe = await insertRecipe('Theirs', {
        addedByUserId: OTHER_USER_ID,
      });
      await insertPlan(OTHER_USER_ID);
      await db.insert(recipeComments).values({
        recipeId: theirRecipe,
        userId: OTHER_USER_ID,
        comment: 'not mine',
      });

      const caller = createCaller(makeContext());
      const summary = await caller.user.getDeletionSummary();
      expect(summary).toEqual({
        commentCount: 0,
        recipeCount: 0,
        planCount: 0,
      });
    });

    it('rejects unauthenticated callers', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(caller.user.getDeletionSummary()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('deleteAccount', () => {
    async function seedFullDataset(): Promise<{
      recipeId: number;
      planId: number;
      slotId: number;
      occasionId: number;
    }> {
      const recipeId = await insertRecipe('Pasta');
      await db
        .insert(recipeRatings)
        .values({ recipeId, userId: USER_ID, rating: 5 });
      await db.insert(recipeComments).values({
        recipeId,
        userId: USER_ID,
        comment: 'lovely',
      });
      await db.insert(recipeDrafts).values({
        userId: USER_ID,
        recipeId,
        draftData: { version: 1, fields: { header: { name: 'in progress' } } },
      });
      const planId = await insertPlan(USER_ID);
      const occasionId = await insertOccasion('Dinner');
      const slotRows = await db
        .insert(mealPlanSlots)
        .values({
          planId,
          date: new Date('2026-06-01'),
          occasionId,
          slotType: 'recipe',
          recipeId,
          numberOfServings: 2,
          chefUserId: USER_ID,
        })
        .returning({ id: mealPlanSlots.id });
      const slot = slotRows[0];
      if (!slot) throw new Error('slot insert failed');
      // Auth-side rows that should disappear via cascade / sweep.
      await db.insert(sessions).values({
        id: SESSION_ID,
        userId: USER_ID,
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await db.insert(accounts).values({
        id: 'acct-1',
        userId: USER_ID,
        accountId: 'acct-1',
        providerId: 'magic-link',
      });
      await db.insert(verifications).values({
        id: 'ver-1',
        identifier: USER_EMAIL,
        value: 'token',
        expiresAt: new Date(Date.now() + 60_000),
      });
      return { recipeId, planId, slotId: slot.id, occasionId };
    }

    it('runs the full tombstoning sequence and removes the user row', async () => {
      const { recipeId, planId, slotId } = await seedFullDataset();

      const caller = createCaller(makeContext());
      const result = await caller.user.deleteAccount({
        emailConfirmation: USER_EMAIL,
      });
      expect(result).toEqual({ deleted: true });

      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, USER_ID));
      expect(userRows).toEqual([]);

      const ratingRows = await db
        .select()
        .from(recipeRatings)
        .where(eq(recipeRatings.recipeId, recipeId));
      expect(ratingRows).toEqual([]);

      const draftRows = await db
        .select()
        .from(recipeDrafts)
        .where(eq(recipeDrafts.recipeId, recipeId));
      expect(draftRows).toEqual([]);

      const commentRows = await db
        .select()
        .from(recipeComments)
        .where(eq(recipeComments.recipeId, recipeId));
      expect(commentRows).toHaveLength(1);
      expect(commentRows[0]?.userId).toBeNull();
      expect(commentRows[0]?.comment).toBe('lovely');

      const recipeRows = await db
        .select()
        .from(recipes)
        .where(eq(recipes.id, recipeId));
      expect(recipeRows).toHaveLength(1);
      expect(recipeRows[0]?.addedByUserId).toBeNull();

      const planRows = await db
        .select()
        .from(mealPlans)
        .where(eq(mealPlans.id, planId));
      expect(planRows).toHaveLength(1);
      expect(planRows[0]?.createdByUserId).toBeNull();

      const slotRows = await db
        .select()
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.id, slotId));
      expect(slotRows).toHaveLength(1);
      expect(slotRows[0]?.chefUserId).toBeNull();

      // Better Auth tables: sessions/accounts cascade, verifications swept.
      const sessionRows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, USER_ID));
      expect(sessionRows).toEqual([]);

      const accountRows = await db
        .select()
        .from(accounts)
        .where(eq(accounts.userId, USER_ID));
      expect(accountRows).toEqual([]);

      const verificationRows = await db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, USER_EMAIL));
      expect(verificationRows).toEqual([]);
    });

    it('does not touch another user’s data', async () => {
      await seedOtherUser();
      const otherRecipe = await insertRecipe('Theirs', {
        addedByUserId: OTHER_USER_ID,
      });
      const otherPlan = await insertPlan(OTHER_USER_ID);
      await db.insert(recipeComments).values({
        recipeId: otherRecipe,
        userId: OTHER_USER_ID,
        comment: 'still here',
      });
      await db
        .insert(recipeRatings)
        .values({ recipeId: otherRecipe, userId: OTHER_USER_ID, rating: 4 });

      const caller = createCaller(makeContext());
      await caller.user.deleteAccount({ emailConfirmation: USER_EMAIL });

      const otherUser = await db
        .select()
        .from(users)
        .where(eq(users.id, OTHER_USER_ID));
      expect(otherUser).toHaveLength(1);

      const theirRecipe = await db
        .select()
        .from(recipes)
        .where(eq(recipes.id, otherRecipe));
      expect(theirRecipe[0]?.addedByUserId).toBe(OTHER_USER_ID);

      const theirPlan = await db
        .select()
        .from(mealPlans)
        .where(eq(mealPlans.id, otherPlan));
      expect(theirPlan[0]?.createdByUserId).toBe(OTHER_USER_ID);

      const theirComment = await db
        .select()
        .from(recipeComments)
        .where(eq(recipeComments.userId, OTHER_USER_ID));
      expect(theirComment).toHaveLength(1);

      const theirRating = await db
        .select()
        .from(recipeRatings)
        .where(eq(recipeRatings.userId, OTHER_USER_ID));
      expect(theirRating).toHaveLength(1);
    });

    it('rejects FORBIDDEN with ACCOUNT_DELETE_EMAIL_MISMATCH when email does not match', async () => {
      await seedFullDataset();

      const caller = createCaller(makeContext());
      await expect(
        caller.user.deleteAccount({ emailConfirmation: 'wrong@example.com' }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { code: 'ACCOUNT_DELETE_EMAIL_MISMATCH' },
      });

      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, USER_ID));
      expect(userRows).toHaveLength(1);
      // Database is untouched on rejection.
      const draftRows = await db
        .select()
        .from(recipeDrafts)
        .where(eq(recipeDrafts.userId, USER_ID));
      expect(draftRows).toHaveLength(1);
      const commentRows = await db
        .select()
        .from(recipeComments)
        .where(eq(recipeComments.userId, USER_ID));
      expect(commentRows).toHaveLength(1);
    });

    it('treats the email comparison as exact (case-sensitive)', async () => {
      await seedFullDataset();
      const caller = createCaller(makeContext());
      await expect(
        caller.user.deleteAccount({
          emailConfirmation: USER_EMAIL.toUpperCase(),
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { code: 'ACCOUNT_DELETE_EMAIL_MISMATCH' },
      });
    });

    it('rolls back every step if the sequence fails midway', async () => {
      const { recipeId, planId, slotId } = await seedFullDataset();

      // Wrap db.transaction so an error is thrown after the procedure's
      // writes complete. This triggers a real Postgres ROLLBACK; the
      // assertions below confirm nothing in the sequence persisted.
      const originalTransaction = db.transaction.bind(db);
      const spy = vi
        .spyOn(db, 'transaction')
        .mockImplementationOnce((fn: Parameters<typeof db.transaction>[0]) =>
          originalTransaction(async (tx) => {
            await fn(tx);
            throw new Error('synthetic mid-transaction failure');
          }),
        );

      const caller = createCaller(makeContext());
      try {
        await expect(
          caller.user.deleteAccount({ emailConfirmation: USER_EMAIL }),
        ).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }

      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, USER_ID));
      expect(userRows).toHaveLength(1);

      const ratingRows = await db
        .select()
        .from(recipeRatings)
        .where(eq(recipeRatings.userId, USER_ID));
      expect(ratingRows).toHaveLength(1);

      const draftRows = await db
        .select()
        .from(recipeDrafts)
        .where(eq(recipeDrafts.userId, USER_ID));
      expect(draftRows).toHaveLength(1);

      const commentRows = await db
        .select()
        .from(recipeComments)
        .where(eq(recipeComments.recipeId, recipeId));
      expect(commentRows).toHaveLength(1);
      expect(commentRows[0]?.userId).toBe(USER_ID);

      const recipeRows = await db
        .select()
        .from(recipes)
        .where(eq(recipes.id, recipeId));
      expect(recipeRows[0]?.addedByUserId).toBe(USER_ID);

      const planRows = await db
        .select()
        .from(mealPlans)
        .where(eq(mealPlans.id, planId));
      expect(planRows[0]?.createdByUserId).toBe(USER_ID);

      const slotRows = await db
        .select()
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.id, slotId));
      expect(slotRows[0]?.chefUserId).toBe(USER_ID);

      const verificationRows = await db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, USER_EMAIL));
      expect(verificationRows).toHaveLength(1);
    });

    it('rejects unauthenticated callers', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.user.deleteAccount({ emailConfirmation: USER_EMAIL }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });
});
