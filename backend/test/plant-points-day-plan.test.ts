import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
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
import { ingredients } from '../src/db/schema/ingredients.ts';
import {
  mealPlans,
  mealPlanSlotItems,
  mealPlanSlots,
} from '../src/db/schema/meal-plans.ts';
import {
  ingredientCategories,
  mealOccasions,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { recipeIngredients, recipes } from '../src/db/schema/recipes.ts';
import {
  selectDayPlantPoints,
  selectPlanPlantPoints,
} from '../src/lib/plant-points.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { appRouter } from '../src/trpc/router.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const USER_ID = 'user-plant-points-1';
const USER_EMAIL = 'plants@example.com';
const SESSION_ID = 'session-plant-points-1';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009dd';

function civilDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

describe('day + plan plant points', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;
  let lunchId!: number;
  let dinnerId!: number;
  let produceCategoryId!: number;
  let unitId!: number;

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
        ${recipeIngredients},
        ${recipes},
        ${ingredients},
        ${ingredientCategories},
        ${unitsOfMeasurement},
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
        name: 'Plant Tester',
        emailVerified: true,
      },
    ]);

    const occasions = await db
      .insert(mealOccasions)
      .values([{ name: 'Lunch' }, { name: 'Dinner' }])
      .returning({ id: mealOccasions.id, name: mealOccasions.name });
    const lunch = occasions.find((row) => row.name === 'Lunch');
    const dinner = occasions.find((row) => row.name === 'Dinner');
    if (!lunch || !dinner) throw new Error('occasions seed failed');
    lunchId = lunch.id;
    dinnerId = dinner.id;

    const categories = await db
      .insert(ingredientCategories)
      .values([{ name: 'Produce' }])
      .returning({ id: ingredientCategories.id });
    const produce = categories[0];
    if (!produce) throw new Error('category seed failed');
    produceCategoryId = produce.id;

    const units = await db
      .insert(unitsOfMeasurement)
      .values([{ name: 'unit' }])
      .returning({ id: unitsOfMeasurement.id });
    const unit = units[0];
    if (!unit) throw new Error('unit seed failed');
    unitId = unit.id;
  });

  interface InsertIngredientOptions {
    isPlant?: boolean;
  }

  async function insertIngredient(
    name: string,
    options: InsertIngredientOptions = {},
  ): Promise<number> {
    const inserted = await db
      .insert(ingredients)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name,
        categoryId: produceCategoryId,
        defaultUnitId: unitId,
        isPlant: options.isPlant ?? false,
      })
      .returning({ id: ingredients.id });
    const row = inserted[0];
    if (!row) throw new Error('ingredient insert failed');
    return row.id;
  }

  interface InsertRecipeOptions {
    isBase?: boolean;
    baseRecipeId?: number | null;
    householdId?: string;
  }

  async function insertRecipe(
    name: string,
    options: InsertRecipeOptions = {},
  ): Promise<number> {
    const inserted = await db
      .insert(recipes)
      .values({
        householdId: options.householdId ?? CURRENT_HOUSEHOLD_ID,
        name,
        baseServings: 4,
        isBase: options.isBase ?? false,
        baseRecipeId: options.baseRecipeId ?? null,
        addedByUserId: USER_ID,
      })
      .returning({ id: recipes.id });
    const row = inserted[0];
    if (!row) throw new Error('recipe insert failed');
    return row.id;
  }

  async function attach(
    recipeId: number,
    ingredientId: number,
    quantity = '1',
  ): Promise<void> {
    await db
      .insert(recipeIngredients)
      .values({ recipeId, ingredientId, quantity });
  }

  interface InsertPlanOptions {
    start: string;
    end: string;
    householdId?: string;
  }

  async function insertPlan(options: InsertPlanOptions): Promise<number> {
    const inserted = await db
      .insert(mealPlans)
      .values({
        householdId: options.householdId ?? CURRENT_HOUSEHOLD_ID,
        createdByUserId: USER_ID,
        startDate: new Date(options.start),
        endDate: new Date(options.end),
      })
      .returning({ id: mealPlans.id });
    const row = inserted[0];
    if (!row) throw new Error('plan insert failed');
    return row.id;
  }

  interface InsertSlotOptions {
    planId: number;
    date: Date;
    occasionId: number;
    slotType?: 'empty' | 'recipe' | 'eat_out' | 'takeaway' | 'leftovers';
    recipeId?: number;
    numberOfServings?: number;
    cooksBaseRecipeId?: number;
    cooksBaseServings?: number;
  }

  async function insertSlot(options: InsertSlotOptions): Promise<number> {
    const slotType = options.slotType ?? 'recipe';
    const inserted = await db
      .insert(mealPlanSlots)
      .values({
        planId: options.planId,
        date: options.date,
        occasionId: options.occasionId,
        slotType,
      })
      .returning({ id: mealPlanSlots.id });
    const row = inserted[0];
    if (!row) throw new Error('slot insert failed');
    // Translate the legacy options into items: the eaten recipe → an `eat`
    // item, the cooked base → a `cook_ahead` item.
    const items: (typeof mealPlanSlotItems.$inferInsert)[] = [];
    if (options.recipeId !== undefined) {
      items.push({
        slotId: row.id,
        recipeId: options.recipeId,
        servings: options.numberOfServings ?? 1,
        kind: 'eat',
        sortOrder: 0,
      });
    }
    if (options.cooksBaseRecipeId !== undefined) {
      items.push({
        slotId: row.id,
        recipeId: options.cooksBaseRecipeId,
        servings: options.cooksBaseServings ?? 1,
        kind: 'cook_ahead',
        sortOrder: 1,
      });
    }
    if (items.length > 0) await db.insert(mealPlanSlotItems).values(items);
    return row.id;
  }

  const day = isoDate(2026, 6, 20);
  const dayDate = civilDate(2026, 6, 20);
  const nextDay = isoDate(2026, 6, 21);
  const nextDayDate = civilDate(2026, 6, 21);

  async function selectForDay(planId: number, date: string): Promise<number> {
    return await selectDayPlantPoints(db, {
      planId,
      householdId: CURRENT_HOUSEHOLD_ID,
      date,
    });
  }
  async function selectForPlan(planId: number): Promise<number> {
    return await selectPlanPlantPoints(db, {
      planId,
      householdId: CURRENT_HOUSEHOLD_ID,
    });
  }

  describe('selectDayPlantPoints', () => {
    it('returns 0 for a day with no slots', async () => {
      const planId = await insertPlan({ start: day, end: day });
      expect(await selectForDay(planId, day)).toBe(0);
    });

    it('counts distinct plant ingredients on a single full recipe', async () => {
      const planId = await insertPlan({ start: day, end: day });
      const recipeId = await insertRecipe('Stir fry');
      const onion = await insertIngredient('Onion', { isPlant: true });
      const pepper = await insertIngredient('Pepper', { isPlant: true });
      const carrot = await insertIngredient('Carrot', { isPlant: true });
      await attach(recipeId, onion);
      await attach(recipeId, pepper);
      await attach(recipeId, carrot);

      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        recipeId,
        numberOfServings: 2,
      });

      expect(await selectForDay(planId, day)).toBe(3);
    });

    it('excludes ingredients with is_plant = false', async () => {
      const planId = await insertPlan({ start: day, end: day });
      const recipeId = await insertRecipe('Sausage and onion');
      const onion = await insertIngredient('Onion', { isPlant: true });
      const sausage = await insertIngredient('Sausage', { isPlant: false });
      await attach(recipeId, onion);
      await attach(recipeId, sausage);

      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        recipeId,
        numberOfServings: 2,
      });

      expect(await selectForDay(planId, day)).toBe(1);
    });

    it('counts the same plant once when present with two prep types', async () => {
      const planId = await insertPlan({ start: day, end: day });
      const recipeId = await insertRecipe('Double onion');
      const onion = await insertIngredient('Onion', { isPlant: true });
      await attach(recipeId, onion);
      await attach(recipeId, onion);

      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        recipeId,
        numberOfServings: 2,
      });

      expect(await selectForDay(planId, day)).toBe(1);
    });

    it('traverses base_recipe_id for serving-variation meals', async () => {
      const planId = await insertPlan({ start: day, end: day });
      const baseId = await insertRecipe('Tomato base', { isBase: true });
      const versionId = await insertRecipe('Tomato pasta', {
        baseRecipeId: baseId,
      });
      const tomato = await insertIngredient('Tomato', { isPlant: true });
      const basil = await insertIngredient('Basil', { isPlant: true });
      const garlic = await insertIngredient('Garlic', { isPlant: true });
      const pasta = await insertIngredient('Pasta', { isPlant: true });
      // Base supplies 4 plants (3 distinct of which one is shared with version)
      await attach(baseId, tomato);
      await attach(baseId, basil);
      await attach(baseId, garlic);
      await attach(baseId, tomato); // dup, dedup
      // Version adds 2 plants, 1 shared (tomato) with base
      await attach(versionId, pasta);
      await attach(versionId, tomato);

      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        recipeId: versionId,
        numberOfServings: 2,
      });

      // distinct plants: tomato, basil, garlic, pasta = 4
      expect(await selectForDay(planId, day)).toBe(4);
    });

    it('unions cooks_base_recipe_id ingredients on a recipe slot', async () => {
      const planId = await insertPlan({ start: day, end: day });
      const baseId = await insertRecipe('Curry base', { isBase: true });
      const mealId = await insertRecipe('Chicken curry');
      const onion = await insertIngredient('Onion', { isPlant: true });
      const chilli = await insertIngredient('Chilli', { isPlant: true });
      const chicken = await insertIngredient('Chicken', { isPlant: false });
      const rice = await insertIngredient('Rice', { isPlant: true });
      await attach(baseId, onion);
      await attach(baseId, chilli);
      await attach(mealId, chicken);
      await attach(mealId, rice);

      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        recipeId: mealId,
        numberOfServings: 2,
        cooksBaseRecipeId: baseId,
        cooksBaseServings: 8,
      });

      // distinct plants: onion, chilli, rice = 3 (chicken is non-plant)
      expect(await selectForDay(planId, day)).toBe(3);
    });

    it('counts cooks_base plants on a takeaway slot', async () => {
      const planId = await insertPlan({ start: day, end: day });
      const baseId = await insertRecipe('Curry base', { isBase: true });
      const onion = await insertIngredient('Onion', { isPlant: true });
      const chilli = await insertIngredient('Chilli', { isPlant: true });
      await attach(baseId, onion);
      await attach(baseId, chilli);

      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        slotType: 'takeaway',
        cooksBaseRecipeId: baseId,
        cooksBaseServings: 8,
      });

      expect(await selectForDay(planId, day)).toBe(2);
    });

    it('returns 0 for a non-recipe slot with no cooked base', async () => {
      const planId = await insertPlan({ start: day, end: day });
      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        slotType: 'eat_out',
      });
      expect(await selectForDay(planId, day)).toBe(0);
    });

    it('dedupes when the meal references the same base as it cooks', async () => {
      const planId = await insertPlan({ start: day, end: day });
      const baseId = await insertRecipe('Bolognese base', { isBase: true });
      const versionId = await insertRecipe('Bolognese pasta', {
        baseRecipeId: baseId,
      });
      const tomato = await insertIngredient('Tomato', { isPlant: true });
      const basil = await insertIngredient('Basil', { isPlant: true });
      const pasta = await insertIngredient('Pasta', { isPlant: true });
      await attach(baseId, tomato);
      await attach(baseId, basil);
      await attach(versionId, pasta);

      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        recipeId: versionId,
        numberOfServings: 2,
        cooksBaseRecipeId: baseId,
        cooksBaseServings: 8,
      });

      // distinct plants: tomato, basil, pasta = 3
      expect(await selectForDay(planId, day)).toBe(3);
    });

    it('does not count plants from other dates in the plan', async () => {
      const planId = await insertPlan({ start: day, end: nextDay });
      const lunchRecipe = await insertRecipe('Salad');
      const dinnerRecipe = await insertRecipe('Soup');
      const apple = await insertIngredient('Apple', { isPlant: true });
      const carrot = await insertIngredient('Carrot', { isPlant: true });
      await attach(lunchRecipe, apple);
      await attach(dinnerRecipe, carrot);

      await insertSlot({
        planId,
        date: dayDate,
        occasionId: lunchId,
        recipeId: lunchRecipe,
        numberOfServings: 2,
      });
      await insertSlot({
        planId,
        date: nextDayDate,
        occasionId: dinnerId,
        recipeId: dinnerRecipe,
        numberOfServings: 2,
      });

      expect(await selectForDay(planId, day)).toBe(1);
      expect(await selectForDay(planId, nextDay)).toBe(1);
    });

    it('returns 0 for a date outside the plan range (no slots)', async () => {
      const planId = await insertPlan({ start: day, end: day });
      expect(await selectForDay(planId, isoDate(2026, 7, 1))).toBe(0);
    });

    it('does not count slots from another household plan', async () => {
      const ourPlan = await insertPlan({ start: day, end: day });
      const theirPlan = await insertPlan({
        start: day,
        end: day,
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const recipeId = await insertRecipe('Veg curry', {
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const onion = await insertIngredient('Onion', { isPlant: true });
      await attach(recipeId, onion);
      await insertSlot({
        planId: theirPlan,
        date: dayDate,
        occasionId: dinnerId,
        recipeId,
        numberOfServings: 2,
      });

      expect(await selectForDay(ourPlan, day)).toBe(0);
    });
  });

  describe('selectPlanPlantPoints', () => {
    it('returns 0 for an empty plan', async () => {
      const planId = await insertPlan({ start: day, end: nextDay });
      expect(await selectForPlan(planId)).toBe(0);
    });

    it('aggregates across days and dedupes shared plants', async () => {
      const planId = await insertPlan({ start: day, end: nextDay });
      const r1 = await insertRecipe('Salad');
      const r2 = await insertRecipe('Stew');
      const onion = await insertIngredient('Onion', { isPlant: true });
      const carrot = await insertIngredient('Carrot', { isPlant: true });
      const potato = await insertIngredient('Potato', { isPlant: true });
      await attach(r1, onion);
      await attach(r1, carrot);
      await attach(r2, carrot);
      await attach(r2, potato);

      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        recipeId: r1,
        numberOfServings: 2,
      });
      await insertSlot({
        planId,
        date: nextDayDate,
        occasionId: dinnerId,
        recipeId: r2,
        numberOfServings: 2,
      });

      // distinct plants across plan: onion, carrot, potato = 3
      expect(await selectForPlan(planId)).toBe(3);
    });

    it('includes batch-traversal and cook-base contributions', async () => {
      const planId = await insertPlan({ start: day, end: nextDay });
      const baseId = await insertRecipe('Tomato base', { isBase: true });
      const versionId = await insertRecipe('Pasta', { baseRecipeId: baseId });
      const tomato = await insertIngredient('Tomato', { isPlant: true });
      const pasta = await insertIngredient('Pasta noodles', { isPlant: true });
      const garlic = await insertIngredient('Garlic', { isPlant: true });
      await attach(baseId, tomato);
      await attach(versionId, pasta);
      const takeaway = await insertRecipe('Curry base', { isBase: true });
      await attach(takeaway, garlic);

      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        recipeId: versionId,
        numberOfServings: 2,
      });
      await insertSlot({
        planId,
        date: nextDayDate,
        occasionId: dinnerId,
        slotType: 'takeaway',
        cooksBaseRecipeId: takeaway,
        cooksBaseServings: 4,
      });

      // distinct plants across plan: tomato (traversal), pasta, garlic = 3
      expect(await selectForPlan(planId)).toBe(3);
    });
  });

  describe('plants tRPC procedures', () => {
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
              name: 'Plant Tester',
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

    it('forDay returns the count for the household plan', async () => {
      const planId = await insertPlan({ start: day, end: day });
      const recipeId = await insertRecipe('Salad');
      const onion = await insertIngredient('Onion', { isPlant: true });
      await attach(recipeId, onion);
      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        recipeId,
        numberOfServings: 2,
      });

      const caller = createCaller(makeContext());
      const result = await caller.plants.forDay({ planId, date: day });
      expect(result).toEqual({ count: 1 });
    });

    it('forPlan returns the count for the household plan', async () => {
      const planId = await insertPlan({ start: day, end: nextDay });
      const recipeId = await insertRecipe('Salad');
      const onion = await insertIngredient('Onion', { isPlant: true });
      await attach(recipeId, onion);
      await insertSlot({
        planId,
        date: dayDate,
        occasionId: dinnerId,
        recipeId,
        numberOfServings: 2,
      });

      const caller = createCaller(makeContext());
      const result = await caller.plants.forPlan({ planId });
      expect(result).toEqual({ count: 1 });
    });

    it('forDay rejects a plan from another household with NOT_FOUND', async () => {
      const foreignPlan = await insertPlan({
        start: day,
        end: day,
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.plants.forDay({ planId: foreignPlan, date: day }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('forPlan rejects a plan from another household with NOT_FOUND', async () => {
      const foreignPlan = await insertPlan({
        start: day,
        end: day,
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.plants.forPlan({ planId: foreignPlan }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('forDay rejects when the caller is unauthenticated', async () => {
      const planId = await insertPlan({ start: day, end: day });
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.plants.forDay({ planId, date: day }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });
});
