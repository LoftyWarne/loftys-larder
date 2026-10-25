import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import { sessions, users } from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import {
  mealPlans,
  mealPlanSlotItems,
  mealPlanSlots,
} from '../src/db/schema/meal-plans.ts';
import { recipeHealthScores } from '../src/db/schema/recipe-health.ts';
import { mealOccasions } from '../src/db/schema/reference.ts';
import { recipes } from '../src/db/schema/recipes.ts';
import {
  roundAverage,
  selectDayHealthScore,
  selectPlanHealthScore,
} from '../src/lib/health-score/average.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { appRouter } from '../src/trpc/router.ts';
import { contextDeps } from './helpers/context-deps.ts';
import {
  startTestDb,
  stopTestDb,
  TESTCONTAINER_BOOT_MS,
  type TestDb,
} from './helpers/test-db.ts';

type Schema = typeof schema;

const USER_ID = 'user-health-average-1';
const USER_EMAIL = 'health-average@example.com';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009ee';

const day = '2026-06-20';
const nextDay = '2026-06-21';

interface Item {
  recipeId: number;
  prepared?: number;
  eaten: number;
}

type SlotType = 'empty' | 'recipe' | 'eat_out' | 'takeaway' | 'leftovers';
type LeftoversSource = 'plan_meal' | 'takeaway' | 'other';

describe('day and plan health score', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let lunchId!: number;
  let dinnerId!: number;

  beforeAll(async () => {
    testDb = await startTestDb({ poolMax: 4 });
    db = testDb.db;
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    await stopTestDb(testDb);
  });

  beforeEach(async () => {
    await db.execute(sql`
      truncate table
        ${recipeHealthScores},
        ${mealPlanSlots},
        ${mealPlans},
        ${recipes},
        ${mealOccasions},
        ${households},
        ${users},
        ${sessions}
      restart identity cascade
    `);
    await db.insert(households).values([
      { id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" },
      { id: OTHER_HOUSEHOLD_ID, name: 'Other Household' },
    ]);
    await db.insert(users).values({
      id: USER_ID,
      email: USER_EMAIL,
      name: 'Health Tester',
      emailVerified: true,
    });
    const occasions = await db
      .insert(mealOccasions)
      .values([{ name: 'Lunch' }, { name: 'Dinner' }])
      .returning({ id: mealOccasions.id, name: mealOccasions.name });
    const lunch = occasions.find((row) => row.name === 'Lunch');
    const dinner = occasions.find((row) => row.name === 'Dinner');
    if (!lunch || !dinner) throw new Error('occasions seed failed');
    lunchId = lunch.id;
    dinnerId = dinner.id;
  });

  async function insertRecipe(
    name: string,
    score: number | null,
    options: {
      isStale?: boolean;
      isDeleted?: boolean;
      householdId?: string;
    } = {},
  ): Promise<number> {
    const [row] = await db
      .insert(recipes)
      .values({
        householdId: options.householdId ?? CURRENT_HOUSEHOLD_ID,
        name,
        baseServings: 4,
        addedByUserId: USER_ID,
        isDeleted: options.isDeleted ?? false,
      })
      .returning({ id: recipes.id });
    if (!row) throw new Error('recipe insert failed');
    if (score !== null) {
      await db.insert(recipeHealthScores).values({
        recipeId: row.id,
        score,
        model: 'fake',
        isStale: options.isStale ?? false,
      });
    }
    return row.id;
  }

  async function insertPlan(
    householdId: string = CURRENT_HOUSEHOLD_ID,
  ): Promise<number> {
    const [row] = await db
      .insert(mealPlans)
      .values({
        householdId,
        createdByUserId: USER_ID,
        startDate: new Date(day),
        endDate: new Date(nextDay),
      })
      .returning({ id: mealPlans.id });
    if (!row) throw new Error('plan insert failed');
    return row.id;
  }

  async function insertSlot(
    planId: number,
    options: {
      date?: string;
      occasionId?: number;
      slotType?: SlotType;
      leftoversSource?: LeftoversSource;
      items?: Item[];
    },
  ): Promise<void> {
    const [row] = await db
      .insert(mealPlanSlots)
      .values({
        planId,
        date: new Date(options.date ?? day),
        occasionId: options.occasionId ?? dinnerId,
        slotType: options.slotType ?? 'recipe',
        leftoversSource: options.leftoversSource ?? null,
      })
      .returning({ id: mealPlanSlots.id });
    if (!row) throw new Error('slot insert failed');
    const items = options.items ?? [];
    if (items.length > 0) {
      await db.insert(mealPlanSlotItems).values(
        items.map((item, index) => ({
          slotId: row.id,
          recipeId: item.recipeId,
          prepared: item.prepared ?? item.eaten,
          eaten: item.eaten,
          sortOrder: index,
        })),
      );
    }
  }

  async function forDay(planId: number, date = day) {
    return await selectDayHealthScore(db, {
      planId,
      householdId: CURRENT_HOUSEHOLD_ID,
      date,
    });
  }

  async function forPlan(planId: number) {
    return await selectPlanHealthScore(db, {
      planId,
      householdId: CURRENT_HOUSEHOLD_ID,
    });
  }

  describe('roundAverage', () => {
    it('rounds to one decimal place, halves up', () => {
      expect(roundAverage(45, 10)).toBe(4.5);
      expect(roundAverage(20, 3)).toBe(6.7);
      expect(roundAverage(13, 4)).toBe(3.3);
      expect(roundAverage(21, 4)).toBe(5.3);
      expect(roundAverage(7, 1)).toBe(7);
    });
  });

  it('weights each dish by its eaten servings', async () => {
    const planId = await insertPlan();
    const salad = await insertRecipe('Salad', 6);
    const pie = await insertRecipe('Pie', 3);
    await insertSlot(planId, {
      items: [
        { recipeId: salad, eaten: 2 },
        { recipeId: pie, eaten: 2 },
      ],
    });
    expect(await forDay(planId)).toEqual({
      average: 4.5,
      notScored: 0,
      includesOutOfDate: false,
    });
  });

  it('weights unequal servings and rounds to one decimal', async () => {
    const planId = await insertPlan();
    const salad = await insertRecipe('Salad', 8);
    const pie = await insertRecipe('Pie', 3);
    await insertSlot(planId, {
      occasionId: lunchId,
      items: [{ recipeId: salad, eaten: 1 }],
    });
    await insertSlot(planId, { items: [{ recipeId: pie, eaten: 2 }] });
    // (8 + 6) / 3 = 4.666…
    expect((await forDay(planId)).average).toBe(4.7);
  });

  it('gives an item with eaten = 0 no weight', async () => {
    const planId = await insertPlan();
    const salad = await insertRecipe('Salad', 6);
    const batch = await insertRecipe('Batch stew', 1);
    await insertSlot(planId, {
      items: [
        { recipeId: salad, eaten: 2 },
        { recipeId: batch, prepared: 6, eaten: 0 },
      ],
    });
    expect(await forDay(planId)).toEqual({
      average: 6,
      notScored: 0,
      includesOutOfDate: false,
    });
  });

  it('counts a plan-meal leftover', async () => {
    const planId = await insertPlan();
    const salad = await insertRecipe('Salad', 6);
    const stew = await insertRecipe('Stew', 2);
    await insertSlot(planId, {
      occasionId: lunchId,
      items: [{ recipeId: salad, eaten: 2 }],
    });
    await insertSlot(planId, {
      slotType: 'leftovers',
      leftoversSource: 'plan_meal',
      items: [{ recipeId: stew, prepared: 0, eaten: 2 }],
    });
    expect((await forDay(planId)).average).toBe(4);
  });

  it('leaves out eat out, takeaway, other leftovers and empty slots', async () => {
    const planId = await insertPlan();
    const salad = await insertRecipe('Salad', 6);
    const batch = await insertRecipe('Batch', 1);
    await insertSlot(planId, {
      occasionId: lunchId,
      items: [{ recipeId: salad, eaten: 2 }],
    });
    await insertSlot(planId, {
      slotType: 'takeaway',
      items: [{ recipeId: batch, prepared: 4, eaten: 0 }],
    });
    await insertSlot(planId, { date: nextDay, slotType: 'eat_out' });
    await insertSlot(planId, {
      date: nextDay,
      occasionId: lunchId,
      slotType: 'empty',
    });
    const other = await insertPlan();
    await insertSlot(other, {
      slotType: 'leftovers',
      leftoversSource: 'other',
    });
    await insertSlot(other, {
      occasionId: lunchId,
      slotType: 'leftovers',
      leftoversSource: 'takeaway',
    });

    expect(await forPlan(planId)).toEqual({
      average: 6,
      notScored: 0,
      includesOutOfDate: false,
    });
    expect(await forDay(planId, nextDay)).toEqual({
      average: null,
      notScored: 0,
      includesOutOfDate: false,
    });
    expect((await forPlan(other)).average).toBeNull();
  });

  it('leaves unscored dishes out and counts each recipe once', async () => {
    const planId = await insertPlan();
    const salad = await insertRecipe('Salad', 6);
    const chilli = await insertRecipe('Chilli', null);
    const curry = await insertRecipe('Curry', null);
    await insertSlot(planId, {
      occasionId: lunchId,
      items: [
        { recipeId: salad, eaten: 2 },
        { recipeId: chilli, eaten: 2 },
      ],
    });
    await insertSlot(planId, { items: [{ recipeId: curry, eaten: 2 }] });
    await insertSlot(planId, {
      date: nextDay,
      items: [{ recipeId: chilli, eaten: 3 }],
    });

    expect(await forDay(planId)).toEqual({
      average: 6,
      notScored: 2,
      includesOutOfDate: false,
    });
    expect(await forPlan(planId)).toEqual({
      average: 6,
      notScored: 2,
      includesOutOfDate: false,
    });
  });

  it('counts an out-of-date score and flags it', async () => {
    const planId = await insertPlan();
    const salad = await insertRecipe('Salad', 6);
    const pie = await insertRecipe('Pie', 3, { isStale: true });
    await insertSlot(planId, {
      items: [
        { recipeId: salad, eaten: 2 },
        { recipeId: pie, eaten: 2 },
      ],
    });
    expect(await forDay(planId)).toEqual({
      average: 4.5,
      notScored: 0,
      includesOutOfDate: true,
    });
  });

  it('counts a soft-deleted recipe with its stored score', async () => {
    const planId = await insertPlan();
    const pie = await insertRecipe('Pie', 3, { isDeleted: true });
    await insertSlot(planId, { items: [{ recipeId: pie, eaten: 2 }] });
    expect((await forDay(planId)).average).toBe(3);
  });

  it('has no value when only unscored dishes are eaten', async () => {
    const planId = await insertPlan();
    const chilli = await insertRecipe('Chilli', null);
    await insertSlot(planId, { items: [{ recipeId: chilli, eaten: 2 }] });
    expect(await forDay(planId)).toEqual({
      average: null,
      notScored: 1,
      includesOutOfDate: false,
    });
    expect(await forDay(planId, nextDay)).toEqual({
      average: null,
      notScored: 0,
      includesOutOfDate: false,
    });
  });

  it('limits the day to its date', async () => {
    const planId = await insertPlan();
    const salad = await insertRecipe('Salad', 6);
    const pie = await insertRecipe('Pie', 2);
    await insertSlot(planId, { items: [{ recipeId: salad, eaten: 2 }] });
    await insertSlot(planId, {
      date: nextDay,
      items: [{ recipeId: pie, eaten: 2 }],
    });
    expect((await forDay(planId)).average).toBe(6);
    expect((await forDay(planId, nextDay)).average).toBe(2);
    expect((await forPlan(planId)).average).toBe(4);
  });

  it("ignores another household's plan in the helper", async () => {
    const foreignPlan = await insertPlan(OTHER_HOUSEHOLD_ID);
    const pie = await insertRecipe('Pie', 3, {
      householdId: OTHER_HOUSEHOLD_ID,
    });
    await insertSlot(foreignPlan, { items: [{ recipeId: pie, eaten: 2 }] });
    expect((await forPlan(foreignPlan)).average).toBeNull();
  });

  describe('healthScores procedures', () => {
    function makeContext(authenticated = true): AppContext {
      return {
        req: {} as AppContext['req'],
        reply: {} as AppContext['reply'],
        reqId: 'rid-test',
        ...contextDeps(),
        db,
        cloudinary: {
          cloudName: 'test-cloud',
          apiKey: 'test-key',
          apiSecret: 'test-secret',
        },
        session: authenticated
          ? {
              id: 'session-health-average-1',
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
              name: 'Health Tester',
              emailVerified: true,
              image: null,
              themePreference: 'system',
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : null,
      };
    }

    it('forDay and forPlan return the average for the household plan', async () => {
      const planId = await insertPlan();
      const salad = await insertRecipe('Salad', 6);
      await insertSlot(planId, { items: [{ recipeId: salad, eaten: 2 }] });
      const caller = appRouter.createCaller(makeContext());
      const expected = { average: 6, notScored: 0, includesOutOfDate: false };
      expect(await caller.healthScores.forDay({ planId, date: day })).toEqual(
        expected,
      );
      expect(await caller.healthScores.forPlan({ planId })).toEqual(expected);
    });

    it("rejects another household's plan with NOT_FOUND", async () => {
      const foreignPlan = await insertPlan(OTHER_HOUSEHOLD_ID);
      const caller = appRouter.createCaller(makeContext());
      await expect(
        caller.healthScores.forDay({ planId: foreignPlan, date: day }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller.healthScores.forPlan({ planId: foreignPlan }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects an unauthenticated caller', async () => {
      const planId = await insertPlan();
      const caller = appRouter.createCaller(makeContext(false));
      await expect(
        caller.healthScores.forPlan({ planId }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });
});
