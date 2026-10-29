import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  ApplyPlanSlot,
  CreatePlanWithSlotsInput,
} from '../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import { users } from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import { ingredients } from '../src/db/schema/ingredients.ts';
import {
  mealPlanSlotDiners,
  mealPlanSlotItems,
  mealPlanSlots,
  mealPlans,
} from '../src/db/schema/meal-plans.ts';
import { recipeHealthScores } from '../src/db/schema/recipe-health.ts';
import { recipeIngredients, recipes } from '../src/db/schema/recipes.ts';
import {
  ingredientCategories,
  mealOccasions,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import {
  addDays,
  eachDateInRange,
  formatCivilDate,
  parseCivilDate,
  todayInLondon,
} from '../src/lib/date-utils.ts';
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

const USER_ID = 'user-apply-test-1';
const PARTNER_ID = 'user-apply-test-2';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009ee';

interface RecipeSeed {
  name: string;
  baseRecipeId?: number | null;
  isBase?: boolean;
  isDeleted?: boolean;
  householdId?: string;
  ingredientIds?: number[];
  score?: number;
}

describe('plan apply and review procedures', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let lunchId!: number;
  let dinnerId!: number;
  let spinachId!: number;
  let lentilsId!: number;
  let saltId!: number;
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
        ${mealPlanSlotDiners},
        ${mealPlanSlotItems},
        ${mealPlanSlots},
        ${mealPlans},
        ${recipeHealthScores},
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
        email: 'apply@example.com',
        name: 'Apply Tester',
        emailVerified: true,
      },
      {
        id: PARTNER_ID,
        email: 'apply-partner@example.com',
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
    const [spinach, lentils, salt] = await db
      .insert(ingredients)
      .values(
        [
          { name: 'Spinach', isPlant: true },
          { name: 'Red Lentils', isPlant: true },
          { name: 'Salt', isPlant: false },
        ].map((ingredient) => ({
          householdId: CURRENT_HOUSEHOLD_ID,
          categoryId: category.id,
          defaultUnitId: g.id,
          ...ingredient,
        })),
      )
      .returning({ id: ingredients.id });
    if (!spinach || !lentils || !salt)
      throw new Error('ingredient seed failed');
    spinachId = spinach.id;
    lentilsId = lentils.id;
    saltId = salt.id;

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
    if (seed.score !== undefined) {
      await db.insert(recipeHealthScores).values({
        recipeId: row.id,
        score: seed.score,
        model: 'fake',
      });
    }
    return row.id;
  }

  function caller(log?: AppContext['log']) {
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
        id: 'session-apply-1',
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
        email: 'apply@example.com',
        name: 'Apply Tester',
        emailVerified: true,
        image: null,
        themePreference: 'system',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      log: log ?? deps.log,
    });
  }

  // Every slot empty with both members eating, unless overridden.
  function slots(
    overrides: (slot: ApplyPlanSlot) => Partial<ApplyPlanSlot> = () => ({}),
  ): ApplyPlanSlot[] {
    return dates.flatMap((date) =>
      [lunchId, dinnerId].map((occasionId) => {
        const slot: ApplyPlanSlot = {
          date,
          occasionId,
          slotType: 'empty',
          leftoversSource: null,
          items: [],
          dinerUserIds: [USER_ID, PARTNER_ID],
          guestCount: 0,
        };
        return { ...slot, ...overrides(slot) };
      }),
    );
  }

  function input(
    overrides: Partial<CreatePlanWithSlotsInput> = {},
  ): CreatePlanWithSlotsInput {
    return {
      startDate: dates[0] ?? '',
      endDate: dates.at(-1) ?? '',
      slots: slots(),
      reviewCounts: null,
      ...overrides,
    };
  }

  function eats(recipeId: number, portions: number) {
    return {
      slotType: 'recipe' as const,
      items: [{ recipeId, prepared: portions, eaten: portions, sortOrder: 0 }],
    };
  }

  async function seedSavedPlan(): Promise<number> {
    const [plan] = await db
      .insert(mealPlans)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        startDate: start,
        endDate: addDays(start, 2),
      })
      .returning({ id: mealPlans.id });
    if (!plan) throw new Error('plan seed failed');
    return plan.id;
  }

  async function planCount(): Promise<number> {
    const rows = await db.select({ id: mealPlans.id }).from(mealPlans);
    return rows.length;
  }

  describe('checking a new plan’s dates', () => {
    it('returns the occasions for an allowed range, and writes nothing', async () => {
      const result = await caller().plans.checkNewDates({
        startDate: dates[0] ?? '',
        endDate: dates.at(-1) ?? '',
      });

      expect(result.occasions).toEqual([
        { id: lunchId, name: 'Lunch' },
        { id: dinnerId, name: 'Dinner' },
      ]);
      expect(await planCount()).toBe(0);
    });

    it('refuses a range over 14 days with plan creation’s error', async () => {
      await expect(
        caller().plans.checkNewDates({
          startDate: dates[0] ?? '',
          endDate: formatCivilDate(addDays(start, 14)),
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'PLAN_RANGE_TOO_LONG' },
      });
    });

    it('refuses a range overlapping an active or future plan', async () => {
      await seedSavedPlan();
      await expect(
        caller().plans.checkNewDates({
          startDate: dates[2] ?? '',
          endDate: formatCivilDate(addDays(start, 5)),
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'PLAN_DATE_OVERLAP' },
      });
    });
  });

  describe('applying a reviewed plan', () => {
    it('creates the plan with attendance, Fixed meals, kept proposals and discarded slots', async () => {
      const roast = await seedRecipe({ name: 'Sunday Roast' });
      const soup = await seedRecipe({ name: 'Lentil Soup' });

      const { plan } = await caller().plans.createWithSlots(
        input({
          slots: slots((slot) => {
            if (slot.date === dates[0] && slot.occasionId === lunchId) {
              return eats(roast, 2);
            }
            if (slot.date === dates[0] && slot.occasionId === dinnerId) {
              return { slotType: 'takeaway', guestCount: 1 };
            }
            if (slot.date === dates[1] && slot.occasionId === lunchId) {
              return { slotType: 'eat_out' };
            }
            if (slot.date === dates[1] && slot.occasionId === dinnerId) {
              return { ...eats(soup, 3), guestCount: 1 };
            }
            if (slot.date === dates[2] && slot.occasionId === lunchId) {
              return { dinerUserIds: [] };
            }
            return { dinerUserIds: [PARTNER_ID] };
          }),
        }),
      );

      expect(plan).toMatchObject({
        startDate: dates[0],
        endDate: dates[2],
        createdByUserId: USER_ID,
      });
      const saved = await caller().plans.get({ id: plan.id });
      const shape = saved.slots.map((slot) => ({
        date: slot.date,
        occasionId: slot.occasionId,
        slotType: slot.slotType,
        recipes: slot.items.map((item) => [
          item.recipeName,
          item.prepared,
          item.eaten,
        ]),
        dinerUserIds: slot.dinerUserIds,
        guestCount: slot.guestCount,
      }));
      expect(shape).toEqual([
        {
          date: dates[0],
          occasionId: lunchId,
          slotType: 'recipe',
          recipes: [['Sunday Roast', 2, 2]],
          dinerUserIds: [USER_ID, PARTNER_ID].sort(),
          guestCount: 0,
        },
        {
          date: dates[0],
          occasionId: dinnerId,
          slotType: 'takeaway',
          recipes: [],
          dinerUserIds: [USER_ID, PARTNER_ID].sort(),
          guestCount: 1,
        },
        {
          date: dates[1],
          occasionId: lunchId,
          slotType: 'eat_out',
          recipes: [],
          dinerUserIds: [USER_ID, PARTNER_ID].sort(),
          guestCount: 0,
        },
        {
          date: dates[1],
          occasionId: dinnerId,
          slotType: 'recipe',
          recipes: [['Lentil Soup', 3, 3]],
          dinerUserIds: [USER_ID, PARTNER_ID].sort(),
          guestCount: 1,
        },
        {
          date: dates[2],
          occasionId: lunchId,
          slotType: 'empty',
          recipes: [],
          dinerUserIds: [],
          guestCount: 0,
        },
        {
          date: dates[2],
          occasionId: dinnerId,
          slotType: 'empty',
          recipes: [],
          dinerUserIds: [PARTNER_ID],
          guestCount: 0,
        },
      ]);
    });

    it('writes Batches and leftovers as the planner does, and the shopping list provisions every prepared portion', async () => {
      const keema = await seedRecipe({ name: 'Keema' });
      const chilli = await seedRecipe({ name: 'Bean Chilli' });
      const soup = await seedRecipe({ name: 'Lentil Soup' });
      const leftovers = (recipeId: number) => ({
        slotType: 'leftovers' as const,
        leftoversSource: 'plan_meal' as const,
        items: [{ recipeId, prepared: 0, eaten: 2, sortOrder: 0 }],
      });

      const { plan } = await caller().plans.createWithSlots(
        input({
          slots: slots((slot) => {
            const at = (day: number, occasionId: number) =>
              slot.date === dates[day] && slot.occasionId === occasionId;
            // A prepared-only Batch where nobody eats.
            if (at(0, lunchId)) {
              return {
                dinerUserIds: [],
                items: [
                  { recipeId: keema, prepared: 4, eaten: 0, sortOrder: 0 },
                ],
              };
            }
            // A Batch Fixed meal, eaten by the headcount at its slot.
            if (at(0, dinnerId)) {
              return {
                slotType: 'recipe',
                items: [
                  { recipeId: chilli, prepared: 6, eaten: 2, sortOrder: 0 },
                ],
              };
            }
            if (at(1, lunchId)) return leftovers(keema);
            if (at(1, dinnerId)) return leftovers(chilli);
            // A proposed Batch.
            if (at(2, lunchId)) {
              return {
                slotType: 'recipe',
                items: [
                  { recipeId: soup, prepared: 4, eaten: 2, sortOrder: 0 },
                ],
              };
            }
            return leftovers(soup);
          }),
        }),
      );

      const saved = await caller().plans.get({ id: plan.id });
      expect(
        saved.slots.map((slot) => [
          slot.slotType,
          slot.leftoversSource,
          slot.items.map((item) => [
            item.recipeName,
            item.prepared,
            item.eaten,
          ]),
        ]),
      ).toEqual([
        ['empty', null, [['Keema', 4, 0]]],
        ['recipe', null, [['Bean Chilli', 6, 2]]],
        ['leftovers', 'plan_meal', [['Keema', 0, 2]]],
        ['leftovers', 'plan_meal', [['Bean Chilli', 0, 2]]],
        ['recipe', null, [['Lentil Soup', 4, 2]]],
        ['leftovers', 'plan_meal', [['Lentil Soup', 0, 2]]],
      ]);

      // 100 g of lentils per 4 portions, for the 14 portions cooked.
      const list = await caller().shopping.getForPlan({ planId: plan.id });
      const line = list.categories[0]?.lines[0];
      expect(line?.ingredient.name).toBe('Red Lentils');
      expect(line?.totalQuantity).toBe('350.000');
      expect(
        line?.contributingSlots.map((contribution) => [
          contribution.recipeName,
          contribution.scaledQuantity,
        ]),
      ).toEqual([
        ['Keema', '100.000'],
        ['Bean Chilli', '150.000'],
        ['Lentil Soup', '100.000'],
      ]);
    });

    it('refuses dates that now clash with plan creation’s error, writing nothing', async () => {
      await seedSavedPlan();
      await expect(
        caller().plans.createWithSlots(input()),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'PLAN_DATE_OVERLAP' },
      });
      expect(await planCount()).toBe(1);
    });

    it('refuses a recipe that is no longer pickable, writing nothing', async () => {
      const gone = await seedRecipe({ name: 'Gone Stew', isDeleted: true });
      await expect(
        caller().plans.createWithSlots(
          input({
            slots: slots((slot) =>
              slot.date === dates[1] && slot.occasionId === dinnerId
                ? eats(gone, 2)
                : {},
            ),
          }),
        ),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'SLOT_RECIPE_NOT_PICKABLE', recipeId: gone },
      });
      expect(await planCount()).toBe(0);
    });

    it('refuses a variation of a deleted base, and another household’s recipe', async () => {
      const base = await seedRecipe({
        name: 'Tomato Base',
        isBase: true,
        isDeleted: true,
      });
      const variation = await seedRecipe({
        name: 'Tomato Pasta',
        baseRecipeId: base,
      });
      const theirs = await seedRecipe({
        name: 'Their Curry',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      for (const recipeId of [variation, theirs]) {
        await expect(
          caller().plans.createWithSlots(
            input({
              slots: slots((slot) =>
                slot.date === dates[0] && slot.occasionId === dinnerId
                  ? eats(recipeId, 2)
                  : {},
              ),
            }),
          ),
        ).rejects.toMatchObject({
          cause: { code: 'SLOT_RECIPE_NOT_PICKABLE' },
        });
      }
      expect(await planCount()).toBe(0);
    });

    it('refuses an unknown diner', async () => {
      await expect(
        caller().plans.createWithSlots(
          input({ slots: slots(() => ({ dinerUserIds: ['nobody'] })) }),
        ),
      ).rejects.toMatchObject({ cause: { code: 'SLOT_DINER_NOT_FOUND' } });
      expect(await planCount()).toBe(0);
    });

    it('refuses slots that don’t cover the range once each', async () => {
      const all = slots();
      const first = all[0];
      if (!first) throw new Error('no slots');
      for (const bad of [all.slice(1), [...all, first]]) {
        await expect(
          caller().plans.createWithSlots(input({ slots: bad })),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
      expect(await planCount()).toBe(0);
    });

    it('refuses a slot that breaks the slot editor’s item rules', async () => {
      const soup = await seedRecipe({ name: 'Lentil Soup' });
      await expect(
        caller().plans.createWithSlots(
          input({
            slots: slots((slot) =>
              slot.date === dates[0] && slot.occasionId === dinnerId
                ? { ...eats(soup, 2), slotType: 'eat_out' }
                : {},
            ),
          }),
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await planCount()).toBe(0);
    });

    it('logs the review’s counts as metadata only, with the request id', async () => {
      const lines: string[] = [];
      const log = pino(
        { level: 'info' },
        { write: (line) => lines.push(line) },
      ).child({ reqId: 'req-apply-1' });
      const soup = await seedRecipe({ name: 'Secret Lentil Soup' });

      await caller(log).plans.createWithSlots(
        input({
          slots: slots((slot) =>
            slot.date === dates[0] && slot.occasionId === dinnerId
              ? eats(soup, 2)
              : {},
          ),
          reviewCounts: {
            suggested: 4,
            swapped: 1,
            discarded: 2,
            suggestedAgain: 0,
            anotherGo: 1,
          },
        }),
      );

      const entries = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => 'modelFeatureEvent' in entry);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        reqId: 'req-apply-1',
        modelFeatureEvent: {
          feature: 'meal-plan',
          event: 'applied',
          slotCount: 6,
          suggested: 4,
          swapped: 1,
          discarded: 2,
          suggestedAgain: 0,
          anotherGo: 1,
        },
      });
      expect(lines.join('\n')).not.toContain('Secret');
    });

    it('refuses counts that aren’t non-negative integers', async () => {
      await expect(
        caller().plans.createWithSlots(
          input({
            reviewCounts: {
              suggested: -1,
              swapped: 0,
              discarded: 0,
              suggestedAgain: 0,
              anotherGo: 0.5,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await planCount()).toBe(0);
    });
  });

  describe('figures over a proposal', () => {
    it('match the saved plan’s plant points and Health Score for the same dishes', async () => {
      const soup = await seedRecipe({
        name: 'Lentil Soup',
        ingredientIds: [lentilsId, saltId],
        score: 8,
      });
      const base = await seedRecipe({
        name: 'Spinach Base',
        isBase: true,
        ingredientIds: [spinachId],
        score: 6,
      });
      const variation = await seedRecipe({
        name: 'Spinach Pasta',
        baseRecipeId: base,
        ingredientIds: [saltId],
      });
      const dishes = [
        { date: dates[0] ?? '', recipeId: soup, eaten: 2 },
        { date: dates[0] ?? '', recipeId: variation, eaten: 2 },
        { date: dates[1] ?? '', recipeId: base, eaten: 3 },
      ];

      const planId = await seedSavedPlan();
      for (const [index, dish] of dishes.entries()) {
        const [slot] = await db
          .insert(mealPlanSlots)
          .values({
            planId,
            date: parseCivilDate(dish.date),
            occasionId: index === 1 ? lunchId : dinnerId,
            slotType: 'recipe',
          })
          .returning({ id: mealPlanSlots.id });
        if (!slot) throw new Error('slot seed failed');
        await db.insert(mealPlanSlotItems).values({
          slotId: slot.id,
          recipeId: dish.recipeId,
          prepared: dish.eaten,
          eaten: dish.eaten,
          sortOrder: 0,
        });
      }

      const figures = await caller().plans.proposedFigures({ dishes });

      const savedDays = await Promise.all(
        [dates[0] ?? '', dates[1] ?? ''].map(async (date) => ({
          date,
          plantPoints: (await caller().plants.forDay({ planId, date })).count,
          healthScore: await caller().healthScores.forDay({ planId, date }),
        })),
      );
      expect(figures.days).toEqual(savedDays);
      expect(figures.plan).toEqual({
        plantPoints: (await caller().plants.forPlan({ planId })).count,
        healthScore: await caller().healthScores.forPlan({ planId }),
      });
      expect(figures.plan).toEqual({
        plantPoints: 2,
        healthScore: { average: 6.8, notScored: 1, includesOutOfDate: false },
      });
    });

    it('counts nothing from another household’s recipe', async () => {
      const theirs = await seedRecipe({
        name: 'Their Soup',
        householdId: OTHER_HOUSEHOLD_ID,
        score: 9,
      });
      const figures = await caller().plans.proposedFigures({
        dishes: [{ date: dates[0] ?? '', recipeId: theirs, eaten: 2 }],
      });
      expect(figures.plan).toEqual({
        plantPoints: 0,
        healthScore: { average: null, notScored: 0, includesOutOfDate: false },
      });
    });

    it('returns empty figures for no dishes', async () => {
      const figures = await caller().plans.proposedFigures({ dishes: [] });
      expect(figures).toEqual({
        days: [],
        plan: {
          plantPoints: 0,
          healthScore: {
            average: null,
            notScored: 0,
            includesOutOfDate: false,
          },
        },
      });
    });
  });
});
