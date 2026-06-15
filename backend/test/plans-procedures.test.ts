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
import { recipes } from '../src/db/schema/recipes.ts';
import { mealOccasions } from '../src/db/schema/reference.ts';
import { formatCivilDate, todayInLondon } from '../src/lib/date-utils.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { appRouter } from '../src/trpc/router.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const USER_ID = 'user-plans-test-1';
const USER_EMAIL = 'plans@example.com';
const SESSION_ID = 'session-plans-test-1';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009bb';

function addDays(date: Date, days: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + days,
    ),
  );
}

describe('plans procedures', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;
  let occasionIds!: number[];

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
    await db.insert(households).values([
      { id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" },
      { id: OTHER_HOUSEHOLD_ID, name: 'Other Household' },
    ]);
    await db.insert(users).values([
      {
        id: USER_ID,
        email: USER_EMAIL,
        name: 'Plan Tester',
        emailVerified: true,
      },
    ]);
    const occasions = await db
      .insert(mealOccasions)
      .values([{ name: 'Lunch' }, { name: 'Dinner' }])
      .returning({ id: mealOccasions.id });
    occasionIds = occasions.map((row) => row.id);
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
            name: 'Plan Tester',
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

  interface InsertPlanOptions {
    name: string;
    startDate: Date;
    endDate: Date;
    householdId?: string;
  }

  async function insertPlan(options: InsertPlanOptions): Promise<number> {
    const inserted = await db
      .insert(mealPlans)
      .values({
        householdId: options.householdId ?? CURRENT_HOUSEHOLD_ID,
        createdByUserId: USER_ID,
        startDate: options.startDate,
        endDate: options.endDate,
        name: options.name,
      })
      .returning({ id: mealPlans.id });
    const row = inserted[0];
    if (!row) throw new Error('plan insert failed');
    return row.id;
  }

  async function insertRecipe(
    name: string,
    options: { isDeleted?: boolean; isBase?: boolean } = {},
  ): Promise<number> {
    const inserted = await db
      .insert(recipes)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name,
        baseServings: 2,
        isBase: options.isBase ?? false,
        isDeleted: options.isDeleted ?? false,
        addedByUserId: USER_ID,
      })
      .returning({ id: recipes.id });
    const row = inserted[0];
    if (!row) throw new Error('recipe insert failed');
    return row.id;
  }

  describe('create', () => {
    it('inserts a plan and generates one empty slot per (date × occasion)', async () => {
      const today = todayInLondon();
      const start = formatCivilDate(today);
      const end = formatCivilDate(addDays(today, 6));

      const caller = createCaller(makeContext());
      const result = await caller.plans.create({
        name: 'Week of greens',
        startDate: start,
        endDate: end,
      });

      expect(result.plan.startDate).toBe(start);
      expect(result.plan.endDate).toBe(end);
      expect(result.plan.createdByUserId).toBe(USER_ID);
      expect(result.slotCount).toBe(7 * occasionIds.length);

      const slots = await db
        .select({
          slotType: mealPlanSlots.slotType,
          recipeId: mealPlanSlots.recipeId,
        })
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.planId, result.plan.id));
      expect(slots).toHaveLength(7 * occasionIds.length);
      for (const slot of slots) {
        expect(slot.slotType).toBe('empty');
        expect(slot.recipeId).toBeNull();
      }
    });

    it('rejects an inverted range with BAD_REQUEST', async () => {
      const today = todayInLondon();
      const caller = createCaller(makeContext());
      await expect(
        caller.plans.create({
          name: 'Backwards',
          startDate: formatCivilDate(addDays(today, 3)),
          endDate: formatCivilDate(today),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects a range longer than 14 days with PLAN_RANGE_TOO_LONG', async () => {
      const today = todayInLondon();
      const caller = createCaller(makeContext());
      await expect(
        caller.plans.create({
          name: 'Too long',
          startDate: formatCivilDate(today),
          endDate: formatCivilDate(addDays(today, 14)),
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'PLAN_RANGE_TOO_LONG' },
      });
    });

    it('rejects overlap with an active plan, rolling back the insert', async () => {
      const today = todayInLondon();
      const existingId = await insertPlan({
        name: 'Existing',
        startDate: today,
        endDate: addDays(today, 6),
      });

      const caller = createCaller(makeContext());
      const error = await caller.plans
        .create({
          name: 'Overlapper',
          startDate: formatCivilDate(addDays(today, 3)),
          endDate: formatCivilDate(addDays(today, 9)),
        })
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'PLAN_DATE_OVERLAP' },
      });
      const cause = (error as { cause: { conflictingPlanIds: number[] } })
        .cause;
      expect(cause.conflictingPlanIds).toEqual([existingId]);

      const remaining = await db.select({ id: mealPlans.id }).from(mealPlans);
      expect(remaining.map((row) => row.id)).toEqual([existingId]);
    });

    it('treats touching boundaries as overlap (inclusive)', async () => {
      const today = todayInLondon();
      await insertPlan({
        name: 'Existing',
        startDate: today,
        endDate: addDays(today, 6),
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.plans.create({
          name: 'Same end day',
          startDate: formatCivilDate(addDays(today, 6)),
          endDate: formatCivilDate(addDays(today, 12)),
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'PLAN_DATE_OVERLAP' },
      });
    });

    it('exempts past plans from the overlap check', async () => {
      const today = todayInLondon();
      await insertPlan({
        name: 'Past',
        startDate: addDays(today, -10),
        endDate: addDays(today, -4),
      });

      const caller = createCaller(makeContext());
      const result = await caller.plans.create({
        name: 'New plan',
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 6)),
      });
      expect(result.plan.id).toBeGreaterThan(0);
    });

    it('ignores plans belonging to other households', async () => {
      const today = todayInLondon();
      await insertPlan({
        name: 'Other household plan',
        startDate: today,
        endDate: addDays(today, 6),
        householdId: OTHER_HOUSEHOLD_ID,
      });

      const caller = createCaller(makeContext());
      const result = await caller.plans.create({
        name: 'Ours',
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 6)),
      });
      expect(result.plan.id).toBeGreaterThan(0);
    });

    it('rejects unauthenticated callers', async () => {
      const today = todayInLondon();
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.plans.create({
          name: 'No auth',
          startDate: formatCivilDate(today),
          endDate: formatCivilDate(today),
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('list', () => {
    it('buckets plans by status relative to today', async () => {
      const today = todayInLondon();
      const pastId = await insertPlan({
        name: 'Past',
        startDate: addDays(today, -10),
        endDate: addDays(today, -4),
      });
      const activeId = await insertPlan({
        name: 'Active',
        startDate: addDays(today, -1),
        endDate: addDays(today, 2),
      });
      const futureId = await insertPlan({
        name: 'Future',
        startDate: addDays(today, 5),
        endDate: addDays(today, 11),
      });

      const caller = createCaller(makeContext());

      const active = await caller.plans.list({ status: 'active' });
      expect(active.items.map((p) => p.id)).toEqual([activeId]);

      const past = await caller.plans.list({ status: 'past' });
      expect(past.items.map((p) => p.id)).toEqual([pastId]);

      const future = await caller.plans.list({ status: 'future' });
      expect(future.items.map((p) => p.id)).toEqual([futureId]);

      const all = await caller.plans.list({ status: 'all' });
      expect(all.items.map((p) => p.id)).toEqual([futureId, activeId, pastId]);
    });

    it('treats today as inclusive at both ends of active', async () => {
      const today = todayInLondon();
      const startsToday = await insertPlan({
        name: 'Starts today',
        startDate: today,
        endDate: addDays(today, 3),
      });
      const endsToday = await insertPlan({
        name: 'Ends today',
        startDate: addDays(today, -3),
        endDate: today,
      });

      const caller = createCaller(makeContext());
      const active = await caller.plans.list({ status: 'active' });
      expect(active.items.map((p) => p.id).sort()).toEqual(
        [startsToday, endsToday].sort(),
      );
    });

    it('excludes plans from other households', async () => {
      const today = todayInLondon();
      await insertPlan({
        name: 'Other',
        startDate: today,
        endDate: addDays(today, 3),
        householdId: OTHER_HOUSEHOLD_ID,
      });
      await insertPlan({
        name: 'Mine',
        startDate: today,
        endDate: addDays(today, 3),
      });

      const caller = createCaller(makeContext());
      const all = await caller.plans.list({ status: 'all' });
      expect(all.items.map((p) => p.name)).toEqual(['Mine']);
    });
  });

  describe('get', () => {
    it('returns the plan with slots ordered by date then occasion', async () => {
      const today = todayInLondon();
      const caller = createCaller(makeContext());
      const created = await caller.plans.create({
        name: 'Detail test',
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 1)),
      });

      const result = await caller.plans.get({ id: created.plan.id });
      expect(result.id).toBe(created.plan.id);
      expect(result.slots).toHaveLength(2 * occasionIds.length);
      for (let i = 1; i < result.slots.length; i += 1) {
        const prev = result.slots[i - 1];
        const cur = result.slots[i];
        if (!prev || !cur) throw new Error('expected slot');
        // Lexicographic compare on YYYY-MM-DD is equivalent to chronological.
        expect(
          prev.date < cur.date ||
            (prev.date === cur.date && prev.occasionId <= cur.occasionId),
        ).toBe(true);
      }
      for (const slot of result.slots) {
        expect(slot.slotType).toBe('empty');
        expect(slot.recipe).toBeNull();
      }
    });

    it('returns the recipe sub-shape on assigned slots, including soft-deleted recipes', async () => {
      const today = todayInLondon();
      const recipeId = await insertRecipe('Tofu Stir Fry');
      const planId = await insertPlan({
        name: 'Manual',
        startDate: today,
        endDate: today,
      });
      const occasionId = occasionIds[0];
      if (occasionId === undefined) throw new Error('expected occasion');
      await db.insert(mealPlanSlots).values({
        planId,
        date: today,
        occasionId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 2,
      });

      const caller = createCaller(makeContext());
      const before = await caller.plans.get({ id: planId });
      const assigned = before.slots.find((s) => s.recipeId === recipeId);
      expect(assigned?.recipe).toEqual({
        id: recipeId,
        name: 'Tofu Stir Fry',
        imageUrl: null,
        isBase: false,
        isDeleted: false,
      });

      await db
        .update(recipes)
        .set({ isDeleted: true })
        .where(eq(recipes.id, recipeId));
      const after = await caller.plans.get({ id: planId });
      const stillThere = after.slots.find((s) => s.recipeId === recipeId);
      expect(stillThere?.recipe?.isDeleted).toBe(true);
    });

    it('returns NOT_FOUND for a plan in another household', async () => {
      const today = todayInLondon();
      const otherId = await insertPlan({
        name: 'Other',
        startDate: today,
        endDate: today,
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(caller.plans.get({ id: otherId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('delete', () => {
    it('removes the plan and cascades to slots', async () => {
      const today = todayInLondon();
      const caller = createCaller(makeContext());
      const created = await caller.plans.create({
        name: 'To go',
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 2)),
      });

      const result = await caller.plans.delete({ id: created.plan.id });
      expect(result.id).toBe(created.plan.id);

      const plans = await db.select({ id: mealPlans.id }).from(mealPlans);
      expect(plans).toHaveLength(0);
      const slots = await db
        .select({ id: mealPlanSlots.id })
        .from(mealPlanSlots);
      expect(slots).toHaveLength(0);
    });

    it('allows a fresh create over the same range after delete', async () => {
      const today = todayInLondon();
      const caller = createCaller(makeContext());
      const first = await caller.plans.create({
        name: 'First',
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 6)),
      });
      await caller.plans.delete({ id: first.plan.id });
      const second = await caller.plans.create({
        name: 'Second',
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 6)),
      });
      expect(second.plan.id).toBeGreaterThan(first.plan.id);
    });

    it('returns NOT_FOUND when deleting another households plan, leaving it intact', async () => {
      const today = todayInLondon();
      const otherId = await insertPlan({
        name: 'Other',
        startDate: today,
        endDate: addDays(today, 2),
        householdId: OTHER_HOUSEHOLD_ID,
      });

      const caller = createCaller(makeContext());
      await expect(caller.plans.delete({ id: otherId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      const remaining = await db
        .select({ id: mealPlans.id })
        .from(mealPlans)
        .where(eq(mealPlans.id, otherId));
      expect(remaining).toHaveLength(1);
    });
  });
});
