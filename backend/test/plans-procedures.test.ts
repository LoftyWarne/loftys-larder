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
        startDate: today,
        endDate: addDays(today, 6),
      });

      const caller = createCaller(makeContext());
      const error = await caller.plans
        .create({
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
        startDate: today,
        endDate: addDays(today, 6),
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.plans.create({
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
        startDate: addDays(today, -10),
        endDate: addDays(today, -4),
      });

      const caller = createCaller(makeContext());
      const result = await caller.plans.create({
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 6)),
      });
      expect(result.plan.id).toBeGreaterThan(0);
    });

    it('ignores plans belonging to other households', async () => {
      const today = todayInLondon();
      await insertPlan({
        startDate: today,
        endDate: addDays(today, 6),
        householdId: OTHER_HOUSEHOLD_ID,
      });

      const caller = createCaller(makeContext());
      const result = await caller.plans.create({
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
        startDate: addDays(today, -10),
        endDate: addDays(today, -4),
      });
      const activeId = await insertPlan({
        startDate: addDays(today, -1),
        endDate: addDays(today, 2),
      });
      const futureId = await insertPlan({
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
        startDate: today,
        endDate: addDays(today, 3),
      });
      const endsToday = await insertPlan({
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
        startDate: today,
        endDate: addDays(today, 3),
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const mineId = await insertPlan({
        startDate: today,
        endDate: addDays(today, 3),
      });

      const caller = createCaller(makeContext());
      const all = await caller.plans.list({ status: 'all' });
      expect(all.items.map((p) => p.id)).toEqual([mineId]);
    });
  });

  describe('get', () => {
    it('returns the plan with slots ordered by date then occasion', async () => {
      const today = todayInLondon();
      const caller = createCaller(makeContext());
      const created = await caller.plans.create({
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
        baseRecipeId: null,
        pairedRecipeId: null,
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
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 6)),
      });
      await caller.plans.delete({ id: first.plan.id });
      const second = await caller.plans.create({
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 6)),
      });
      expect(second.plan.id).toBeGreaterThan(first.plan.id);
    });

    it('returns NOT_FOUND when deleting another households plan, leaving it intact', async () => {
      const today = todayInLondon();
      const otherId = await insertPlan({
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

  describe('updateRange', () => {
    interface SlotRow {
      id: number;
      date: Date;
      occasionId: number;
      slotType: 'empty' | 'recipe' | 'eat_out' | 'takeaway' | 'leftovers';
      recipeId: number | null;
    }

    async function listSlots(planId: number): Promise<SlotRow[]> {
      return db
        .select({
          id: mealPlanSlots.id,
          date: mealPlanSlots.date,
          occasionId: mealPlanSlots.occasionId,
          slotType: mealPlanSlots.slotType,
          recipeId: mealPlanSlots.recipeId,
        })
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.planId, planId));
    }

    async function seedPlan(
      start: Date,
      end: Date,
    ): Promise<{ planId: number; slotCount: number }> {
      const caller = createCaller(makeContext());
      const result = await caller.plans.create({
        startDate: formatCivilDate(start),
        endDate: formatCivilDate(end),
      });
      return { planId: result.plan.id, slotCount: result.slotCount };
    }

    it('extends forward by appending empty slots without disturbing existing ones', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 3));
      const before = await listSlots(planId);

      const caller = createCaller(makeContext());
      const result = await caller.plans.updateRange({
        id: planId,
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 6)),
      });

      expect(result.startDate).toBe(formatCivilDate(today));
      expect(result.endDate).toBe(formatCivilDate(addDays(today, 6)));
      expect(result.slots).toHaveLength(7 * occasionIds.length);

      const after = await listSlots(planId);
      const survivingIds = new Set(before.map((s) => s.id));
      for (const original of before) {
        expect(after.some((s) => s.id === original.id)).toBe(true);
      }
      const newSlots = after.filter((s) => !survivingIds.has(s.id));
      expect(newSlots).toHaveLength(3 * occasionIds.length);
      for (const slot of newSlots) {
        expect(slot.slotType).toBe('empty');
      }
    });

    it('extends backward by prepending empty slots', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 3));

      const caller = createCaller(makeContext());
      const newStart = addDays(today, -2);
      const result = await caller.plans.updateRange({
        id: planId,
        startDate: formatCivilDate(newStart),
        endDate: formatCivilDate(addDays(today, 3)),
      });

      expect(result.startDate).toBe(formatCivilDate(newStart));
      expect(result.slots).toHaveLength(6 * occasionIds.length);
      const slotDates = new Set(result.slots.map((s) => s.date));
      expect(slotDates.has(formatCivilDate(newStart))).toBe(true);
      expect(slotDates.has(formatCivilDate(addDays(today, -1)))).toBe(true);
    });

    it('shrinks from the end by deleting empty out-of-range slots', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 6));
      const before = await listSlots(planId);
      const beforeIdsForDay3 = new Set(
        before
          .filter(
            (s) =>
              formatCivilDate(s.date) === formatCivilDate(addDays(today, 3)),
          )
          .map((s) => s.id),
      );

      const caller = createCaller(makeContext());
      const result = await caller.plans.updateRange({
        id: planId,
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 3)),
      });

      expect(result.endDate).toBe(formatCivilDate(addDays(today, 3)));
      expect(result.slots).toHaveLength(4 * occasionIds.length);
      // In-range slots (e.g. the original day 3 row) survive with their ids.
      for (const id of beforeIdsForDay3) {
        expect(result.slots.some((s) => s.id === id)).toBe(true);
      }
    });

    it('shrinks from the start by deleting empty out-of-range slots', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 6));

      const caller = createCaller(makeContext());
      const result = await caller.plans.updateRange({
        id: planId,
        startDate: formatCivilDate(addDays(today, 3)),
        endDate: formatCivilDate(addDays(today, 6)),
      });

      expect(result.startDate).toBe(formatCivilDate(addDays(today, 3)));
      expect(result.slots).toHaveLength(4 * occasionIds.length);
      for (const slot of result.slots) {
        expect(slot.date >= formatCivilDate(addDays(today, 3))).toBe(true);
      }
    });

    it('applies a mixed shrink + extend as a symmetric diff, preserving in-range assignments', async () => {
      const today = todayInLondon();
      const recipeId = await insertRecipe('Pesto pasta');
      const { planId } = await seedPlan(today, addDays(today, 4));
      const occasionId = occasionIds[0];
      if (occasionId === undefined) throw new Error('expected occasion');
      // Assign a recipe to the slot at day+2 (which will remain in range).
      const assignedDate = addDays(today, 2);
      const [assignedSlot] = await db
        .update(mealPlanSlots)
        .set({ slotType: 'recipe', recipeId, numberOfServings: 2 })
        .where(
          and(
            eq(mealPlanSlots.planId, planId),
            eq(mealPlanSlots.date, assignedDate),
            eq(mealPlanSlots.occasionId, occasionId),
          ),
        )
        .returning({ id: mealPlanSlots.id });
      if (!assignedSlot) throw new Error('expected assignment');

      const caller = createCaller(makeContext());
      // Shift the window: drop day 0, drop day 3-4, keep days 1-2, add days 5-6.
      const result = await caller.plans.updateRange({
        id: planId,
        startDate: formatCivilDate(addDays(today, 1)),
        endDate: formatCivilDate(addDays(today, 6)),
      });

      expect(result.slots).toHaveLength(6 * occasionIds.length);
      const survivor = result.slots.find((s) => s.id === assignedSlot.id);
      expect(survivor).toBeDefined();
      expect(survivor?.slotType).toBe('recipe');
      expect(survivor?.recipeId).toBe(recipeId);
      expect(survivor?.numberOfServings).toBe(2);
    });

    it('is a no-op when the range is unchanged', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 3));
      const before = await listSlots(planId);

      const caller = createCaller(makeContext());
      const result = await caller.plans.updateRange({
        id: planId,
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 3)),
      });

      const after = await listSlots(planId);
      expect(after.map((s) => s.id).sort()).toEqual(
        before.map((s) => s.id).sort(),
      );
      expect(result.slots).toHaveLength(before.length);
    });

    it('rejects a destructive shrink without confirmation, leaving the plan untouched', async () => {
      const today = todayInLondon();
      const recipeId = await insertRecipe('Tofu Stir Fry');
      const { planId } = await seedPlan(today, addDays(today, 6));
      const occasionId = occasionIds[0];
      if (occasionId === undefined) throw new Error('expected occasion');
      const lostDate = addDays(today, 5);
      const [assigned] = await db
        .update(mealPlanSlots)
        .set({ slotType: 'recipe', recipeId, numberOfServings: 3 })
        .where(
          and(
            eq(mealPlanSlots.planId, planId),
            eq(mealPlanSlots.date, lostDate),
            eq(mealPlanSlots.occasionId, occasionId),
          ),
        )
        .returning({ id: mealPlanSlots.id });
      if (!assigned) throw new Error('expected assignment');

      const caller = createCaller(makeContext());
      const error = await caller.plans
        .updateRange({
          id: planId,
          startDate: formatCivilDate(today),
          endDate: formatCivilDate(addDays(today, 3)),
        })
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'PLAN_DESTRUCTIVE_RANGE_CHANGE' },
      });
      const cause = (
        error as {
          cause: {
            slots: {
              id: number;
              date: string;
              occasionId: number;
              slotType: string;
              recipeId: number | null;
            }[];
          };
        }
      ).cause;
      expect(cause.slots).toHaveLength(1);
      expect(cause.slots[0]).toMatchObject({
        id: assigned.id,
        date: formatCivilDate(lostDate),
        occasionId,
        slotType: 'recipe',
        recipeId,
      });

      const after = await listSlots(planId);
      expect(after).toHaveLength(7 * occasionIds.length);
      const [planAfter] = await db
        .select({
          startDate: mealPlans.startDate,
          endDate: mealPlans.endDate,
        })
        .from(mealPlans)
        .where(eq(mealPlans.id, planId));
      expect(planAfter?.endDate.getTime()).toBe(addDays(today, 6).getTime());
    });

    it('proceeds with a destructive shrink when confirmDestructive is true', async () => {
      const today = todayInLondon();
      const recipeId = await insertRecipe('Sushi bowl');
      const { planId } = await seedPlan(today, addDays(today, 6));
      const occasionId = occasionIds[0];
      if (occasionId === undefined) throw new Error('expected occasion');
      const lostDate = addDays(today, 5);
      await db
        .update(mealPlanSlots)
        .set({ slotType: 'recipe', recipeId, numberOfServings: 2 })
        .where(
          and(
            eq(mealPlanSlots.planId, planId),
            eq(mealPlanSlots.date, lostDate),
            eq(mealPlanSlots.occasionId, occasionId),
          ),
        );

      const caller = createCaller(makeContext());
      const result = await caller.plans.updateRange({
        id: planId,
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 3)),
        confirmDestructive: true,
      });

      expect(result.slots).toHaveLength(4 * occasionIds.length);
      const after = await listSlots(planId);
      expect(
        after.some(
          (s) => formatCivilDate(s.date) === formatCivilDate(lostDate),
        ),
      ).toBe(false);
    });

    it('does not require confirmation when shrunk dates only carry empty slots', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 6));

      const caller = createCaller(makeContext());
      const result = await caller.plans.updateRange({
        id: planId,
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 3)),
      });
      expect(result.slots).toHaveLength(4 * occasionIds.length);
    });

    it('rejects an overlap with another active plan and rolls back', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 3));
      const neighbourId = await insertPlan({
        startDate: addDays(today, 6),
        endDate: addDays(today, 9),
      });
      const beforeSlots = await listSlots(planId);

      const caller = createCaller(makeContext());
      const error = await caller.plans
        .updateRange({
          id: planId,
          startDate: formatCivilDate(today),
          endDate: formatCivilDate(addDays(today, 7)),
        })
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'PLAN_DATE_OVERLAP' },
      });
      const cause = (error as { cause: { conflictingPlanIds: number[] } })
        .cause;
      expect(cause.conflictingPlanIds).toEqual([neighbourId]);

      const afterSlots = await listSlots(planId);
      expect(afterSlots.map((s) => s.id).sort()).toEqual(
        beforeSlots.map((s) => s.id).sort(),
      );
    });

    it('does not flag the plan itself as a self-conflict', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 3));

      const caller = createCaller(makeContext());
      const result = await caller.plans.updateRange({
        id: planId,
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 5)),
      });
      expect(result.endDate).toBe(formatCivilDate(addDays(today, 5)));
    });

    it('rejects an inverted range via Zod refine', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 3));

      const caller = createCaller(makeContext());
      await expect(
        caller.plans.updateRange({
          id: planId,
          startDate: formatCivilDate(addDays(today, 3)),
          endDate: formatCivilDate(today),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects a range longer than 14 days with PLAN_RANGE_TOO_LONG', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 3));

      const caller = createCaller(makeContext());
      await expect(
        caller.plans.updateRange({
          id: planId,
          startDate: formatCivilDate(today),
          endDate: formatCivilDate(addDays(today, 14)),
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'PLAN_RANGE_TOO_LONG' },
      });
    });

    it('rejects editing a plan whose current range is entirely in the past', async () => {
      const today = todayInLondon();
      const planId = await insertPlan({
        startDate: addDays(today, -10),
        endDate: addDays(today, -3),
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.plans.updateRange({
          id: planId,
          startDate: formatCivilDate(addDays(today, -10)),
          endDate: formatCivilDate(today),
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'PLAN_PAST_NOT_EDITABLE' },
      });
    });

    it('returns NOT_FOUND when targeting another households plan', async () => {
      const today = todayInLondon();
      const otherId = await insertPlan({
        startDate: today,
        endDate: addDays(today, 2),
        householdId: OTHER_HOUSEHOLD_ID,
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.plans.updateRange({
          id: otherId,
          startDate: formatCivilDate(today),
          endDate: formatCivilDate(addDays(today, 3)),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns slots ordered by date then occasionId', async () => {
      const today = todayInLondon();
      const { planId } = await seedPlan(today, addDays(today, 1));

      const caller = createCaller(makeContext());
      const result = await caller.plans.updateRange({
        id: planId,
        startDate: formatCivilDate(today),
        endDate: formatCivilDate(addDays(today, 2)),
      });

      for (let i = 1; i < result.slots.length; i += 1) {
        const prev = result.slots[i - 1];
        const cur = result.slots[i];
        if (!prev || !cur) throw new Error('expected slot');
        expect(
          prev.date < cur.date ||
            (prev.date === cur.date && prev.occasionId <= cur.occasionId),
        ).toBe(true);
      }
    });
  });

  describe('duplicate', () => {
    async function seedPlan(
      start: Date,
      end: Date,
    ): Promise<{ planId: number; slotCount: number }> {
      const caller = createCaller(makeContext());
      const result = await caller.plans.create({
        startDate: formatCivilDate(start),
        endDate: formatCivilDate(end),
      });
      return { planId: result.plan.id, slotCount: result.slotCount };
    }

    it('copies all slot assignments with dates shifted by the offset', async () => {
      const today = todayInLondon();
      const recipeId = await insertRecipe('Tofu Stir Fry');
      const baseRecipeId = await insertRecipe('Basmati Rice', { isBase: true });

      const sourceStart = addDays(today, -10);
      const sourceEnd = addDays(today, -7);
      const { planId: sourceId } = await seedPlan(sourceStart, sourceEnd);

      const dinnerId = occasionIds[0];
      const lunchId = occasionIds[1];
      if (dinnerId === undefined || lunchId === undefined) {
        throw new Error('expected two occasions');
      }

      // One recipe slot (with chef), one eat_out, the rest empty. Add a
      // base-cook annotation to the recipe slot so the cooks_base_* fields
      // get copied too.
      await db
        .update(mealPlanSlots)
        .set({
          slotType: 'recipe',
          recipeId,
          numberOfServings: 3,
          chefUserId: USER_ID,
          cooksBaseRecipeId: baseRecipeId,
          cooksBaseServings: 6,
        })
        .where(
          and(
            eq(mealPlanSlots.planId, sourceId),
            eq(mealPlanSlots.date, sourceStart),
            eq(mealPlanSlots.occasionId, dinnerId),
          ),
        );
      await db
        .update(mealPlanSlots)
        .set({ slotType: 'eat_out' })
        .where(
          and(
            eq(mealPlanSlots.planId, sourceId),
            eq(mealPlanSlots.date, addDays(sourceStart, 1)),
            eq(mealPlanSlots.occasionId, lunchId),
          ),
        );

      const newStart = addDays(today, 5);
      const caller = createCaller(makeContext());
      const result = await caller.plans.duplicate({
        planId: sourceId,
        newStartDate: formatCivilDate(newStart),
      });

      // Duration preserved (4 days inclusive → endDate = newStart + 3).
      expect(result.plan.startDate).toBe(formatCivilDate(newStart));
      expect(result.plan.endDate).toBe(formatCivilDate(addDays(newStart, 3)));
      expect(result.plan.createdByUserId).toBe(USER_ID);
      expect(result.slotCount).toBe(4 * occasionIds.length);

      const newSlots = await db
        .select({
          date: mealPlanSlots.date,
          occasionId: mealPlanSlots.occasionId,
          slotType: mealPlanSlots.slotType,
          recipeId: mealPlanSlots.recipeId,
          numberOfServings: mealPlanSlots.numberOfServings,
          chefUserId: mealPlanSlots.chefUserId,
          cooksBaseRecipeId: mealPlanSlots.cooksBaseRecipeId,
          cooksBaseServings: mealPlanSlots.cooksBaseServings,
        })
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.planId, result.plan.id));

      expect(newSlots).toHaveLength(4 * occasionIds.length);

      const recipeSlot = newSlots.find(
        (s) =>
          formatCivilDate(s.date) === formatCivilDate(newStart) &&
          s.occasionId === dinnerId,
      );
      expect(recipeSlot).toMatchObject({
        slotType: 'recipe',
        recipeId,
        numberOfServings: 3,
        chefUserId: USER_ID,
        cooksBaseRecipeId: baseRecipeId,
        cooksBaseServings: 6,
      });

      const eatOutSlot = newSlots.find(
        (s) =>
          formatCivilDate(s.date) === formatCivilDate(addDays(newStart, 1)) &&
          s.occasionId === lunchId,
      );
      expect(eatOutSlot?.slotType).toBe('eat_out');
      expect(eatOutSlot?.recipeId).toBeNull();

      // Every other slot stays empty.
      const nonAssigned = newSlots.filter(
        (s) => s !== recipeSlot && s !== eatOutSlot,
      );
      for (const slot of nonAssigned) {
        expect(slot.slotType).toBe('empty');
        expect(slot.recipeId).toBeNull();
      }

      // Source plan is unchanged.
      const sourceSlots = await db
        .select({ id: mealPlanSlots.id })
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.planId, sourceId));
      expect(sourceSlots).toHaveLength(4 * occasionIds.length);
    });

    it('allows duplicating a past plan into the future', async () => {
      const today = todayInLondon();
      const sourceId = await insertPlan({
        startDate: addDays(today, -14),
        endDate: addDays(today, -8),
      });

      const caller = createCaller(makeContext());
      const result = await caller.plans.duplicate({
        planId: sourceId,
        newStartDate: formatCivilDate(addDays(today, 1)),
      });

      expect(result.plan.startDate).toBe(formatCivilDate(addDays(today, 1)));
      expect(result.plan.endDate).toBe(formatCivilDate(addDays(today, 7)));
    });

    it('rejects overlap with an existing active plan via CONFLICT + PLAN_DATE_OVERLAP', async () => {
      const today = todayInLondon();
      const sourceId = await insertPlan({
        startDate: addDays(today, -10),
        endDate: addDays(today, -4),
      });
      const blockingId = await insertPlan({
        startDate: addDays(today, 2),
        endDate: addDays(today, 8),
      });

      const caller = createCaller(makeContext());
      const error = await caller.plans
        .duplicate({
          planId: sourceId,
          newStartDate: formatCivilDate(addDays(today, 1)),
        })
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'PLAN_DATE_OVERLAP' },
      });
      const cause = (error as { cause: { conflictingPlanIds: number[] } })
        .cause;
      expect(cause.conflictingPlanIds).toEqual([blockingId]);

      // No partial state — source + blocker only.
      const allPlans = await db.select({ id: mealPlans.id }).from(mealPlans);
      expect(allPlans.map((p) => p.id).sort((a, b) => a - b)).toEqual(
        [sourceId, blockingId].sort((a, b) => a - b),
      );
    });

    it('exempts past plans from the overlap check', async () => {
      const today = todayInLondon();
      const sourceId = await insertPlan({
        startDate: addDays(today, -20),
        endDate: addDays(today, -16),
      });
      await insertPlan({
        startDate: addDays(today, -10),
        endDate: addDays(today, -6),
      });

      const caller = createCaller(makeContext());
      // Duplicate into a range that overlaps the past plan but no
      // active/future plan — should succeed.
      const result = await caller.plans.duplicate({
        planId: sourceId,
        newStartDate: formatCivilDate(addDays(today, -8)),
      });

      expect(result.plan.startDate).toBe(formatCivilDate(addDays(today, -8)));
      expect(result.plan.endDate).toBe(formatCivilDate(addDays(today, -4)));
    });

    it('treats touching boundaries as overlap (inclusive)', async () => {
      const today = todayInLondon();
      // Source range is 8 days inclusive → duplicated with newStart=today
      // gives newEnd=today+7, exactly touching the blocker's start date.
      const sourceId = await insertPlan({
        startDate: addDays(today, -10),
        endDate: addDays(today, -3),
      });
      await insertPlan({
        startDate: addDays(today, 7),
        endDate: addDays(today, 13),
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.plans.duplicate({
          planId: sourceId,
          newStartDate: formatCivilDate(today),
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'PLAN_DATE_OVERLAP' },
      });
    });

    it('returns NOT_FOUND for a plan in another household', async () => {
      const today = todayInLondon();
      const otherId = await insertPlan({
        startDate: addDays(today, -5),
        endDate: addDays(today, -3),
        householdId: OTHER_HOUSEHOLD_ID,
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.plans.duplicate({
          planId: otherId,
          newStartDate: formatCivilDate(addDays(today, 1)),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns NOT_FOUND for a non-existent plan id', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.plans.duplicate({
          planId: 99999,
          newStartDate: formatCivilDate(todayInLondon()),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rolls back the plan insert when the slot copy throws', async () => {
      const today = todayInLondon();
      const { planId: sourceId } = await seedPlan(
        addDays(today, -10),
        addDays(today, -8),
      );

      // Wrap db.transaction so an error is thrown inside the callback after
      // the procedure's writes complete. This triggers a real Postgres
      // ROLLBACK; assertions below confirm neither the plan row nor the
      // slot rows survived.
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
          caller.plans.duplicate({
            planId: sourceId,
            newStartDate: formatCivilDate(addDays(today, 1)),
          }),
        ).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }

      // No orphan plan or slots for the attempted newStart date.
      const orphanPlans = await db
        .select({ id: mealPlans.id })
        .from(mealPlans)
        .where(eq(mealPlans.startDate, addDays(today, 1)));
      expect(orphanPlans).toHaveLength(0);

      const allPlans = await db.select({ id: mealPlans.id }).from(mealPlans);
      expect(allPlans.map((p) => p.id)).toEqual([sourceId]);
    });
  });
});
