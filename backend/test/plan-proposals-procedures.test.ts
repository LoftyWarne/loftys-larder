import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  MealPlanRequest,
  ProposePlanInput,
  ProposePlanSlot,
} from '../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import { users } from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import { ingredients } from '../src/db/schema/ingredients.ts';
import {
  mealPlanSlotItems,
  mealPlanSlots,
  mealPlans,
} from '../src/db/schema/meal-plans.ts';
import { recipeHealthScores } from '../src/db/schema/recipe-health.ts';
import { recipeRatings } from '../src/db/schema/recipe-social.ts';
import {
  recipeIngredients,
  recipeMethod,
  recipeTagLinks,
  recipeTags,
  recipes,
} from '../src/db/schema/recipes.ts';
import {
  ingredientCategories,
  mealOccasions,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import {
  addDays,
  eachDateInRange,
  formatCivilDate,
  todayInLondon,
} from '../src/lib/date-utils.ts';
import {
  createFakeMealPlanner,
  FAKE_PLANNER_MARKERS,
  FAKE_PLANNER_REASON,
  FAKE_PLANNER_SUMMARY,
} from '../src/lib/meal-planner/fake.ts';
import type { MealPlanner } from '../src/lib/meal-planner/types.ts';
import { loadPlannerLibrary } from '../src/lib/plan-proposal/request.ts';
import type { ModelRateLimitVerdict } from '../src/plugins/rate-limit.ts';
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

const USER_ID = 'user-proposals-test-1';
const PARTNER_ID = 'user-proposals-test-2';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009dd';
const SINCE = '2026-10-07';

interface RecipeSeed {
  name: string;
  isBase?: boolean;
  baseRecipeId?: number | null;
  isDeleted?: boolean;
  householdId?: string;
  ingredientIds?: number[];
  activeTimeMins?: number | null;
  totalTimeMins?: number | null;
}

describe('plan proposal procedures', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let lunchId!: number;
  let dinnerId!: number;
  let spinachId!: number;
  let lentilsId!: number;
  // The plan proposed in most tests: three days, a week from now.
  let start!: Date;
  let dates!: string[];

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
        ${mealPlanSlotItems},
        ${mealPlanSlots},
        ${mealPlans},
        ${recipeRatings},
        ${recipeHealthScores},
        ${recipeTagLinks},
        ${recipeTags},
        ${recipeMethod},
        ${recipeIngredients},
        ${recipes},
        ${ingredients},
        ${ingredientCategories},
        ${unitsOfMeasurement},
        ${mealOccasions},
        ${households},
        ${users}
      restart identity cascade
    `);
    await db.insert(households).values([
      { id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" },
      { id: OTHER_HOUSEHOLD_ID, name: 'Other Household' },
    ]);
    await db.insert(users).values([
      {
        id: USER_ID,
        email: 'proposals@example.com',
        name: 'Proposal Tester',
        emailVerified: true,
      },
      {
        id: PARTNER_ID,
        email: 'partner@example.com',
        name: 'Partner',
        emailVerified: true,
      },
    ]);
    const [lunch, dinner] = await db
      .insert(mealOccasions)
      .values([{ name: 'Lunch' }, { name: 'Dinner' }])
      .returning({ id: mealOccasions.id });
    const [category] = await db
      .insert(ingredientCategories)
      .values({ name: 'Fruit & Veg' })
      .returning();
    const [g] = await db
      .insert(unitsOfMeasurement)
      .values({ name: 'g' })
      .returning();
    if (!lunch || !dinner || !category || !g) throw new Error('seed failed');
    lunchId = lunch.id;
    dinnerId = dinner.id;
    const [spinach, lentils] = await db
      .insert(ingredients)
      .values(
        ['Spinach', 'Red Lentils'].map((name) => ({
          householdId: CURRENT_HOUSEHOLD_ID,
          name,
          categoryId: category.id,
          defaultUnitId: g.id,
          isPlant: true,
        })),
      )
      .returning({ id: ingredients.id });
    if (!spinach || !lentils) throw new Error('ingredient seed failed');
    spinachId = spinach.id;
    lentilsId = lentils.id;

    start = addDays(todayInLondon(), 7);
    dates = eachDateInRange(start, addDays(start, 2)).map(formatCivilDate);
  });

  async function seedRecipe(seed: RecipeSeed): Promise<number> {
    const [row] = await db
      .insert(recipes)
      .values({
        householdId: seed.householdId ?? CURRENT_HOUSEHOLD_ID,
        name: seed.name,
        baseServings: 4,
        isBase: seed.isBase ?? false,
        baseRecipeId: seed.baseRecipeId ?? null,
        isDeleted: seed.isDeleted ?? false,
        activeTimeMins: seed.activeTimeMins ?? null,
        totalTimeMins: seed.totalTimeMins ?? null,
        estimatedCostPerServing: '3.50',
        caloriesPerServing: 456,
      })
      .returning({ id: recipes.id });
    if (!row) throw new Error('recipe seed failed');
    const ingredientIds = seed.ingredientIds ?? [lentilsId];
    if (ingredientIds.length > 0) {
      await db.insert(recipeIngredients).values(
        ingredientIds.map((ingredientId) => ({
          recipeId: row.id,
          ingredientId,
          quantity: '100',
        })),
      );
    }
    await db.insert(recipeMethod).values({
      recipeId: row.id,
      stepNumber: 1,
      instruction: 'Whisper the hidden method.',
    });
    return row.id;
  }

  // A plan holding one slot per entry, each eating its recipe unless
  // `eaten` is 0.
  async function seedPlan(
    planStart: Date,
    planEnd: Date,
    items: { date: Date; recipeId: number; eaten?: number }[],
    householdId = CURRENT_HOUSEHOLD_ID,
  ) {
    const [plan] = await db
      .insert(mealPlans)
      .values({ householdId, startDate: planStart, endDate: planEnd })
      .returning({ id: mealPlans.id });
    if (!plan) throw new Error('plan seed failed');
    for (const item of items) {
      const [slot] = await db
        .insert(mealPlanSlots)
        .values({
          planId: plan.id,
          date: item.date,
          occasionId: dinnerId,
          slotType: (item.eaten ?? 2) > 0 ? 'recipe' : 'empty',
        })
        .onConflictDoNothing()
        .returning({ id: mealPlanSlots.id });
      if (!slot) continue;
      await db.insert(mealPlanSlotItems).values({
        slotId: slot.id,
        recipeId: item.recipeId,
        prepared: 2,
        eaten: item.eaten ?? 2,
        sortOrder: 0,
      });
    }
  }

  function slots(
    overrides: (slot: ProposePlanSlot) => Partial<ProposePlanSlot> = () => ({}),
  ): ProposePlanSlot[] {
    return dates.flatMap((date) =>
      [lunchId, dinnerId].map((occasionId) => {
        const slot: ProposePlanSlot = {
          date,
          occasionId,
          dinerUserIds: [USER_ID, PARTNER_ID],
          guestCount: 0,
          fixed: null,
        };
        return { ...slot, ...overrides(slot) };
      }),
    );
  }

  function input(overrides: Partial<ProposePlanInput> = {}): ProposePlanInput {
    return {
      startDate: dates[0] ?? '',
      endDate: dates.at(-1) ?? '',
      slots: slots(),
      brief: null,
      note: null,
      previous: null,
      ...overrides,
    };
  }

  interface ContextOptions {
    planner?: MealPlanner;
    allowProposal?: () => Promise<ModelRateLimitVerdict>;
    log?: AppContext['log'];
  }

  function caller(options: ContextOptions = {}) {
    const deps = contextDeps();
    return appRouter.createCaller({
      ...deps,
      req: {} as AppContext['req'],
      reply: {} as AppContext['reply'],
      reqId: 'rid-test',
      db,
      cloudinary: {
        cloudName: 'test-cloud',
        apiKey: 'test-key',
        apiSecret: 'test-secret',
      },
      session: {
        id: 'session-proposals-1',
        userId: USER_ID,
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
        ipAddress: null,
        userAgent: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: USER_ID,
        email: 'proposals@example.com',
        name: 'Proposal Tester',
        emailVerified: true,
        image: null,
        themePreference: 'system',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      log: options.log ?? deps.log,
      mealPlan: {
        planner: options.planner ?? createFakeMealPlanner(),
        healthScoreSince: SINCE,
        allowProposal:
          options.allowProposal ??
          (() => Promise.resolve({ allowed: true, retryAfterSeconds: 0 })),
      },
    });
  }

  function spyPlanner(inner: MealPlanner = createFakeMealPlanner()) {
    const requests: MealPlanRequest[] = [];
    const planner: MealPlanner = {
      adapter: inner.adapter,
      model: inner.model,
      propose: (request, signal) => {
        requests.push(request);
        return inner.propose(request, signal);
      },
    };
    return { planner, requests };
  }

  function countingLimit(verdict = { allowed: true, retryAfterSeconds: 0 }) {
    const calls = { count: 0 };
    return {
      calls,
      allowProposal: () => {
        calls.count += 1;
        return Promise.resolve(verdict);
      },
    };
  }

  async function planCount(): Promise<number> {
    const rows = await db.select({ id: mealPlans.id }).from(mealPlans);
    return rows.length;
  }

  describe('building the request', () => {
    it('sends each pickable recipe’s fields, and nothing else', async () => {
      const baseId = await seedRecipe({ name: 'Tomato Sauce', isBase: true });
      const id = await seedRecipe({
        name: 'Spinach Dal',
        baseRecipeId: baseId,
        ingredientIds: [spinachId, lentilsId, spinachId],
        activeTimeMins: 15,
        totalTimeMins: 40,
      });
      const [tag] = await db
        .insert(recipeTags)
        .values({ householdId: CURRENT_HOUSEHOLD_ID, name: 'Weeknight' })
        .returning({ id: recipeTags.id });
      if (!tag) throw new Error('tag seed failed');
      await db.insert(recipeTagLinks).values({ recipeId: id, tagId: tag.id });
      await db.insert(recipeRatings).values([
        { recipeId: id, userId: USER_ID, rating: 4 },
        { recipeId: id, userId: PARTNER_ID, rating: 5 },
      ]);
      await db.insert(recipeHealthScores).values({
        recipeId: id,
        score: 8,
        summary: 'Plenty of veg.',
        model: 'earlier-model',
        scoredAt: new Date('2026-10-08T10:00:00Z'),
        isStale: false,
      });

      const { planner, requests } = spyPlanner();
      await caller({ planner }).planProposals.propose(input());

      const sent = requests[0];
      expect(sent?.recipes).toEqual([
        {
          id: baseId,
          name: 'Tomato Sauce',
          tags: [],
          kind: 'base',
          baseRecipeId: null,
          baseServings: 4,
          activeMins: null,
          totalMins: null,
          averageRating: null,
          healthScore: null,
          healthScoreOutOfDate: false,
          ingredientNames: ['Red Lentils'],
          lastPlannedOn: null,
          timesPlannedLast4Weeks: 0,
        },
        {
          id,
          name: 'Spinach Dal',
          tags: ['Weeknight'],
          kind: 'variation',
          baseRecipeId: baseId,
          baseServings: 4,
          activeMins: 15,
          totalMins: 40,
          averageRating: 4.5,
          healthScore: 8,
          healthScoreOutOfDate: false,
          ingredientNames: ['Spinach', 'Red Lentils'],
          lastPlannedOn: null,
          timesPlannedLast4Weeks: 0,
        },
      ]);
      const json = JSON.stringify(sent);
      expect(json).not.toContain('Whisper the hidden method');
      expect(json).not.toContain('3.5');
      expect(json).not.toContain('456');
      expect(json).not.toContain('Plenty of veg');
    });

    it('sends headcounts, never who the diners are', async () => {
      await seedRecipe({ name: 'Lentil Soup' });
      const { planner, requests } = spyPlanner();
      await caller({ planner }).planProposals.propose(
        input({
          slots: slots(() => ({
            dinerUserIds: [USER_ID, USER_ID],
            guestCount: 2,
          })),
          brief: '  Something light  ',
        }),
      );
      const sent = requests[0];
      expect(sent?.slots[0]).toEqual({
        date: dates[0],
        occasion: 'Lunch',
        headcount: 3,
        fixed: null,
      });
      expect(sent?.brief).toBe('Something light');
      expect(JSON.stringify(sent)).not.toContain(USER_ID);
    });

    it('leaves out soft-deleted recipes, other households’ recipes and variations of a deleted base', async () => {
      const kept = await seedRecipe({ name: 'Lentil Soup' });
      await seedRecipe({ name: 'Old Soup', isDeleted: true });
      await seedRecipe({ name: 'Theirs', householdId: OTHER_HOUSEHOLD_ID });
      const deletedBase = await seedRecipe({
        name: 'Gone Base',
        isBase: true,
        isDeleted: true,
      });
      await seedRecipe({ name: 'Orphan', baseRecipeId: deletedBase });

      const { planner, requests } = spyPlanner();
      await caller({ planner }).planProposals.propose(input());
      expect(requests[0]?.recipes.map((recipe) => recipe.id)).toEqual([kept]);
    });

    it('works out recency from eaten slots in the 28 days before the start', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      const other = await seedRecipe({ name: 'Bean Chilli' });
      const day = (offset: number) => addDays(start, offset);
      await seedPlan(day(-40), day(-27), [
        // Before the window, which for a plan starting on day 1 opens on
        // day -27.
        { date: day(-29), recipeId: id },
        { date: day(-28), recipeId: id },
        // Prepared, not eaten.
        { date: day(-3), recipeId: other, eaten: 0 },
      ]);
      await seedPlan(day(-2), day(0), [
        { date: day(-1), recipeId: id },
        { date: day(0), recipeId: id },
      ]);
      await seedPlan(
        day(-10),
        day(-5),
        [{ date: day(-6), recipeId: id }],
        OTHER_HOUSEHOLD_ID,
      );

      const { planner, requests } = spyPlanner();
      await caller({ planner }).planProposals.propose(
        input({
          startDate: formatCivilDate(day(1)),
          endDate: formatCivilDate(day(3)),
          slots: eachDateInRange(day(1), day(3)).flatMap((date) =>
            [lunchId, dinnerId].map((occasionId) => ({
              date: formatCivilDate(date),
              occasionId,
              dinerUserIds: [USER_ID],
              guestCount: 0,
              fixed: null,
            })),
          ),
        }),
      );
      const byId = new Map(
        requests[0]?.recipes.map((recipe) => [recipe.id, recipe]),
      );
      expect(byId.get(id)).toMatchObject({
        lastPlannedOn: formatCivilDate(day(0)),
        timesPlannedLast4Weeks: 2,
      });
      expect(byId.get(other)).toMatchObject({
        lastPlannedOn: null,
        timesPlannedLast4Weeks: 0,
      });
    });

    it('counts no slot on or after the start', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await seedPlan(addDays(start, -1), addDays(start, 1), [
        { date: addDays(start, -1), recipeId: id },
        { date: start, recipeId: id },
        { date: addDays(start, 1), recipeId: id },
      ]);
      const [recipe] = await loadPlannerLibrary(db, {
        startDate: start,
        healthScoreSince: SINCE,
      });
      expect(recipe).toMatchObject({
        lastPlannedOn: formatCivilDate(addDays(start, -1)),
        timesPlannedLast4Weeks: 1,
      });
    });

    it('marks a stale score, or one from an older scorer, out of date', async () => {
      const stale = await seedRecipe({ name: 'Stale' });
      const older = await seedRecipe({ name: 'Older' });
      await db.insert(recipeHealthScores).values([
        {
          recipeId: stale,
          score: 5,
          model: 'm',
          scoredAt: new Date('2026-10-08T10:00:00Z'),
          isStale: true,
        },
        {
          recipeId: older,
          score: 6,
          model: 'm',
          scoredAt: new Date('2026-10-01T10:00:00Z'),
          isStale: false,
        },
      ]);
      const { planner, requests } = spyPlanner();
      await caller({ planner }).planProposals.propose(input());
      expect(
        requests[0]?.recipes.map((recipe) => recipe.healthScoreOutOfDate),
      ).toEqual([true, true]);
    });

    it('sends a rerun’s note and previous proposal by occasion name, only for this plan’s slots', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      const { planner, requests } = spyPlanner();
      await caller({ planner }).planProposals.propose(
        input({
          note: 'Less soup',
          previous: {
            slots: [
              {
                date: dates[0] ?? '',
                occasionId: dinnerId,
                slotType: 'recipe',
                leftoversSource: null,
                items: [{ recipeId: id, prepared: 2, eaten: 2 }],
                reason: 'Warming.',
              },
              // Not in this plan: dropped.
              {
                date: formatCivilDate(addDays(start, 30)),
                occasionId: dinnerId,
                slotType: 'recipe',
                leftoversSource: null,
                items: [{ recipeId: id, prepared: 2, eaten: 2 }],
                reason: 'Padding.',
              },
            ],
            summary: 'Soup week.',
            dropped: 0,
          },
        }),
      );
      expect(requests[0]?.note).toBe('Less soup');
      expect(requests[0]?.previous).toEqual({
        slots: [{ date: dates[0], occasion: 'Dinner', recipeId: id }],
        summary: 'Soup week.',
      });
    });
  });

  describe('proposing', () => {
    it('proposes every slot that isn’t fixed, through the fake adapter, and writes nothing', async () => {
      const soup = await seedRecipe({ name: 'Lentil Soup' });
      const chilli = await seedRecipe({ name: 'Bean Chilli' });
      const before = await planCount();

      const proposal = await caller().planProposals.propose(
        input({
          slots: slots((slot) =>
            slot.date === dates[0] && slot.occasionId === lunchId
              ? { fixed: { kind: 'recipe', recipeId: chilli } }
              : slot.date === dates[0]
                ? { fixed: { kind: 'eat_out' } }
                : slot.date === dates[1] && slot.occasionId === lunchId
                  ? { fixed: { kind: 'empty' } }
                  : {},
          ),
        }),
      );

      expect(proposal.summary).toBe(FAKE_PLANNER_SUMMARY);
      expect(proposal.dropped).toBe(0);
      expect(
        proposal.slots.map((slot) => [slot.date, slot.occasionId]),
      ).toEqual([
        [dates[1], dinnerId],
        [dates[2], lunchId],
        [dates[2], dinnerId],
      ]);
      expect(proposal.slots[0]).toEqual({
        date: dates[1],
        occasionId: dinnerId,
        slotType: 'recipe',
        leftoversSource: null,
        items: [
          {
            recipeId: soup,
            prepared: 2,
            eaten: 2,
            recipeName: 'Lentil Soup',
            recipeImageUrl: null,
            isBase: false,
            baseRecipeId: null,
          },
        ],
        reason: FAKE_PLANNER_REASON,
      });
      expect(await planCount()).toBe(before);
    });

    it('leaves a slot with nobody eating empty', async () => {
      await seedRecipe({ name: 'Lentil Soup' });
      const proposal = await caller().planProposals.propose(
        input({
          slots: slots((slot) =>
            slot.occasionId === lunchId
              ? { dinerUserIds: [], guestCount: 0 }
              : {},
          ),
        }),
      );
      const lunches = proposal.slots.filter(
        (slot) => slot.occasionId === lunchId,
      );
      expect(lunches.every((slot) => slot.slotType === 'empty')).toBe(true);
      expect(proposal.dropped).toBe(0);
    });

    it('asks no model when every slot is fixed or has nobody eating', async () => {
      await seedRecipe({ name: 'Lentil Soup' });
      const { planner, requests } = spyPlanner();
      const limit = countingLimit();
      const proposal = await caller({
        planner,
        allowProposal: limit.allowProposal,
      }).planProposals.propose(
        input({
          slots: slots((slot) =>
            slot.occasionId === lunchId
              ? { fixed: { kind: 'takeaway' } }
              : { dinerUserIds: [], guestCount: 0 },
          ),
        }),
      );
      expect(requests).toHaveLength(0);
      expect(limit.calls.count).toBe(0);
      expect(proposal.slots).toHaveLength(3);
      expect(proposal.slots.every((slot) => slot.slotType === 'empty')).toBe(
        true,
      );
    });
  });

  describe('errors', () => {
    async function refusedBeforeTheModel(
      call: (c: ReturnType<typeof caller>) => Promise<unknown>,
      expected: Record<string, unknown>,
    ) {
      const { planner, requests } = spyPlanner();
      const limit = countingLimit();
      await expect(
        call(caller({ planner, allowProposal: limit.allowProposal })),
      ).rejects.toMatchObject(expected);
      expect(requests).toHaveLength(0);
      expect(limit.calls.count).toBe(0);
    }

    it('refuses a range over 14 days with plan creation’s error', async () => {
      await seedRecipe({ name: 'Lentil Soup' });
      await refusedBeforeTheModel(
        (c) =>
          c.planProposals.propose(
            input({ endDate: formatCivilDate(addDays(start, 14)) }),
          ),
        { code: 'BAD_REQUEST', cause: { code: 'PLAN_RANGE_TOO_LONG' } },
      );
    });

    it('refuses a range overlapping an active or future plan', async () => {
      await seedRecipe({ name: 'Lentil Soup' });
      await seedPlan(addDays(start, 2), addDays(start, 5), []);
      await refusedBeforeTheModel((c) => c.planProposals.propose(input()), {
        code: 'CONFLICT',
        cause: { code: 'PLAN_DATE_OVERLAP' },
      });
    });

    it('refuses with no pickable recipes', async () => {
      await seedRecipe({ name: 'Old Soup', isDeleted: true });
      await refusedBeforeTheModel((c) => c.planProposals.propose(input()), {
        code: 'UNPROCESSABLE_CONTENT',
        cause: { code: 'MEAL_PLAN_NO_RECIPES' },
      });
    });

    it('refuses slots that don’t cover the range once each', async () => {
      await seedRecipe({ name: 'Lentil Soup' });
      const all = slots();
      const second = all[1];
      if (!second) throw new Error('no second slot');
      await refusedBeforeTheModel(
        (c) => c.planProposals.propose(input({ slots: all.slice(1) })),
        { code: 'BAD_REQUEST' },
      );
      await refusedBeforeTheModel(
        (c) =>
          c.planProposals.propose(input({ slots: [...all.slice(1), second] })),
        { code: 'BAD_REQUEST' },
      );
    });

    it('refuses an unknown diner', async () => {
      await seedRecipe({ name: 'Lentil Soup' });
      await refusedBeforeTheModel(
        (c) =>
          c.planProposals.propose(
            input({ slots: slots(() => ({ dinerUserIds: ['nobody'] })) }),
          ),
        { code: 'BAD_REQUEST', cause: { code: 'SLOT_DINER_NOT_FOUND' } },
      );
    });

    it('refuses a fixed recipe that isn’t pickable', async () => {
      await seedRecipe({ name: 'Lentil Soup' });
      const deleted = await seedRecipe({ name: 'Old Soup', isDeleted: true });
      await refusedBeforeTheModel(
        (c) =>
          c.planProposals.propose(
            input({
              slots: slots((slot) =>
                slot.occasionId === lunchId
                  ? { fixed: { kind: 'recipe', recipeId: deleted } }
                  : {},
              ),
            }),
          ),
        {
          code: 'BAD_REQUEST',
          cause: { code: 'SLOT_RECIPE_NOT_PICKABLE', recipeId: deleted },
        },
      );
    });

    it('refuses over the limit, with the seconds until retry', async () => {
      await seedRecipe({ name: 'Lentil Soup' });
      const { planner, requests } = spyPlanner();
      await expect(
        caller({
          planner,
          allowProposal: () =>
            Promise.resolve({ allowed: false, retryAfterSeconds: 1200 }),
        }).planProposals.propose(input()),
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        cause: { code: 'MEAL_PLAN_RATE_LIMITED', retryAfterSeconds: 1200 },
      });
      expect(requests).toHaveLength(0);
    });

    it('counts a call that reaches the model', async () => {
      await seedRecipe({ name: 'Lentil Soup' });
      const limit = countingLimit();
      await caller({
        allowProposal: limit.allowProposal,
      }).planProposals.propose(input());
      expect(limit.calls.count).toBe(1);
    });

    it.each([
      [
        FAKE_PLANNER_MARKERS.refused,
        'UNPROCESSABLE_CONTENT',
        { code: 'MEAL_PLAN_NOT_PROPOSED' },
      ],
      [
        FAKE_PLANNER_MARKERS.timeout,
        'GATEWAY_TIMEOUT',
        { code: 'MEAL_PLAN_TRY_AGAIN', reason: 'timeout' },
      ],
      [
        FAKE_PLANNER_MARKERS.unavailable,
        'SERVICE_UNAVAILABLE',
        { code: 'MEAL_PLAN_TRY_AGAIN', reason: 'unavailable' },
      ],
      [
        FAKE_PLANNER_MARKERS.invalid,
        'BAD_GATEWAY',
        { code: 'MEAL_PLAN_TRY_AGAIN', reason: 'invalid_result' },
      ],
      [
        FAKE_PLANNER_MARKERS.rejected,
        'INTERNAL_SERVER_ERROR',
        { code: 'MEAL_PLAN_REQUEST_REJECTED' },
      ],
    ])('maps %s to %s', async (marker, code, cause) => {
      await seedRecipe({ name: 'Lentil Soup' });
      const before = await planCount();
      await expect(
        caller().planProposals.propose(input({ brief: marker })),
      ).rejects.toMatchObject({ code, cause });
      expect(await planCount()).toBe(before);
    });
  });

  describe('logging', () => {
    it('logs metadata only, with the request id', async () => {
      const lines: string[] = [];
      const log = pino(
        { level: 'info' },
        { write: (line) => lines.push(line) },
      ).child({ reqId: 'req-plan-1' });
      const id = await seedRecipe({ name: 'Grandmas Secret Stew' });
      await caller({ log }).planProposals.propose(
        input({
          brief: 'Use up the secret spinach',
          slots: slots((slot) =>
            slot.date === dates[0] && slot.occasionId === lunchId
              ? { fixed: { kind: 'recipe', recipeId: id } }
              : slot.date === dates[0]
                ? { fixed: { kind: 'empty' } }
                : {},
          ),
        }),
      );
      await expect(
        caller({ log }).planProposals.propose(
          input({ brief: `Secret ${FAKE_PLANNER_MARKERS.refused}` }),
        ),
      ).rejects.toBeDefined();

      const entries = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => 'modelUsage' in entry);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        reqId: 'req-plan-1',
        modelUsage: {
          feature: 'meal-plan',
          adapter: 'fake',
          model: 'fake',
          inputTokens: 0,
          outputTokens: 0,
          outcome: 'proposed',
          slotCount: 6,
          fixedCount: 1,
          libraryCount: 1,
          dropped: 0,
          briefLength: 'Use up the secret spinach'.length,
          rerun: false,
        },
      });
      expect(entries[0]?.modelUsage).toHaveProperty('latencyMs');
      expect(entries[1]?.modelUsage).toMatchObject({
        outcome: 'MEAL_PLAN_NOT_PROPOSED',
      });

      const output = lines.join('');
      expect(output).not.toMatch(/secret/i);
      expect(output).not.toContain(FAKE_PLANNER_REASON);
      expect(output).not.toContain(FAKE_PLANNER_SUMMARY);
    });
  });
});
