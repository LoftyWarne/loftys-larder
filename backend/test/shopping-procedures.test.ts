import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
  preparationTypes,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { recipeIngredients, recipes } from '../src/db/schema/recipes.ts';
import { shoppingListItems } from '../src/db/schema/shopping-list.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { appRouter } from '../src/trpc/router.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const USER_ID = 'user-shopping-test-1';
const USER_EMAIL = 'shopping@example.com';
const SESSION_ID = 'session-shopping-test-1';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009cc';

function civilDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

describe('shopping procedures', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;
  let lunchId!: number;
  let dinnerId!: number;
  let produceCategoryId!: number;
  let pantryCategoryId!: number;
  let unitId!: number;
  let gramsUnitId!: number;

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
        ${shoppingListItems},
        ${mealPlanSlots},
        ${mealPlans},
        ${recipeIngredients},
        ${recipes},
        ${ingredients},
        ${ingredientCategories},
        ${unitsOfMeasurement},
        ${preparationTypes},
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
        name: 'Shopping Tester',
        emailVerified: true,
      },
    ]);

    const occasionsInserted = await db
      .insert(mealOccasions)
      .values([{ name: 'Lunch' }, { name: 'Dinner' }])
      .returning({ id: mealOccasions.id });
    const [lunch, dinner] = occasionsInserted;
    if (!lunch || !dinner) throw new Error('meal occasions seed failed');
    lunchId = lunch.id;
    dinnerId = dinner.id;

    const categoriesInserted = await db
      .insert(ingredientCategories)
      .values([{ name: 'Produce' }, { name: 'Pantry' }])
      .returning({ id: ingredientCategories.id });
    const [produce, pantry] = categoriesInserted;
    if (!produce || !pantry) throw new Error('categories seed failed');
    produceCategoryId = produce.id;
    pantryCategoryId = pantry.id;

    const unitsInserted = await db
      .insert(unitsOfMeasurement)
      .values([{ name: 'unit' }, { name: 'grams' }])
      .returning({ id: unitsOfMeasurement.id });
    const [unitRow, gramsRow] = unitsInserted;
    if (!unitRow || !gramsRow) throw new Error('units seed failed');
    unitId = unitRow.id;
    gramsUnitId = gramsRow.id;
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
            name: 'Shopping Tester',
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

  interface InsertIngredientOptions {
    categoryId?: number;
    defaultUnitId?: number;
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
        categoryId: options.categoryId ?? produceCategoryId,
        defaultUnitId: options.defaultUnitId ?? unitId,
        isPlant: options.isPlant ?? false,
      })
      .returning({ id: ingredients.id });
    const row = inserted[0];
    if (!row) throw new Error('ingredient insert failed');
    return row.id;
  }

  interface InsertRecipeOptions {
    baseServings?: number;
    isBase?: boolean;
    baseRecipeId?: number | null;
    isDeleted?: boolean;
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
        baseServings: options.baseServings ?? 4,
        isBase: options.isBase ?? false,
        baseRecipeId: options.baseRecipeId ?? null,
        isDeleted: options.isDeleted ?? false,
        addedByUserId: USER_ID,
      })
      .returning({ id: recipes.id });
    const row = inserted[0];
    if (!row) throw new Error('recipe insert failed');
    return row.id;
  }

  async function insertRecipeIngredient(
    recipeId: number,
    ingredientId: number,
    quantity: string,
  ): Promise<void> {
    await db.insert(recipeIngredients).values({
      recipeId,
      ingredientId,
      quantity,
    });
  }

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

  interface InsertSlotOptions {
    planId: number;
    date: Date;
    occasionId: number;
    slotType: 'empty' | 'recipe' | 'eat_out' | 'takeaway' | 'leftovers';
    recipeId?: number;
    numberOfServings?: number;
    cooksBaseRecipeId?: number;
    cooksBaseServings?: number;
  }

  async function insertSlot(options: InsertSlotOptions): Promise<number> {
    const inserted = await db
      .insert(mealPlanSlots)
      .values({
        planId: options.planId,
        date: options.date,
        occasionId: options.occasionId,
        slotType: options.slotType,
        leftoversSource: options.slotType === 'leftovers' ? 'other' : null,
      })
      .returning({ id: mealPlanSlots.id });
    const row = inserted[0];
    if (!row) throw new Error('slot insert failed');
    // Translate the legacy options into items (DEC-91). An eaten dish on a
    // `recipe` slot is cooked here (prepared == eaten); on a leftovers /
    // eat-out / takeaway slot it's provisioned elsewhere, so it's a pure-consume
    // row (prepared 0) that contributes nothing to the buy list. A cooked base
    // is a prepared-only batch (eaten 0).
    const items: (typeof mealPlanSlotItems.$inferInsert)[] = [];
    if (options.recipeId !== undefined) {
      const servings = options.numberOfServings ?? 1;
      items.push({
        slotId: row.id,
        recipeId: options.recipeId,
        prepared: options.slotType === 'recipe' ? servings : 0,
        eaten: servings,
        sortOrder: 0,
      });
    }
    if (options.cooksBaseRecipeId !== undefined) {
      items.push({
        slotId: row.id,
        recipeId: options.cooksBaseRecipeId,
        prepared: options.cooksBaseServings ?? 1,
        eaten: 0,
        sortOrder: 1,
      });
    }
    if (items.length > 0) await db.insert(mealPlanSlotItems).values(items);
    return row.id;
  }

  describe('getForPlan', () => {
    it('returns one line scaled 1× when slot servings equals baseServings', async () => {
      const onionId = await insertIngredient('Onion');
      const recipeId = await insertRecipe('Curry', { baseServings: 4 });
      await insertRecipeIngredient(recipeId, onionId, '2.000');

      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      const slotId = await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 4,
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });

      expect(result.planId).toBe(planId);
      expect(result.categories).toHaveLength(1);
      const line = result.categories[0]?.lines[0];
      expect(line?.ingredient.name).toBe('Onion');
      expect(line?.unit.name).toBe('unit');
      expect(line?.totalQuantity).toBe('2.000');
      expect(line?.contributingSlots).toEqual([
        {
          slotId,
          recipeId,
          recipeName: 'Curry',
          date: '2026-01-01',
          scaledQuantity: '2.000',
        },
      ]);
    });

    it('scales by slot servings / base servings', async () => {
      const onionId = await insertIngredient('Onion');
      const recipeId = await insertRecipe('Curry', { baseServings: 4 });
      await insertRecipeIngredient(recipeId, onionId, '2.000');

      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 2),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: lunchId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 8,
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 2),
        occasionId: lunchId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 2,
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      const line = result.categories[0]?.lines[0];
      // 2 × (8/4) + 2 × (2/4) = 4 + 1 = 5
      expect(line?.totalQuantity).toBe('5.000');
      expect(line?.contributingSlots.map((c) => c.scaledQuantity)).toEqual([
        '4.000',
        '1.000',
      ]);
    });

    it('sums contributions from two recipes sharing an ingredient', async () => {
      const onionId = await insertIngredient('Onion');
      const curryId = await insertRecipe('Curry', { baseServings: 4 });
      const stewId = await insertRecipe('Stew', { baseServings: 4 });
      await insertRecipeIngredient(curryId, onionId, '2.000');
      await insertRecipeIngredient(stewId, onionId, '1.000');

      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 2),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId: curryId,
        numberOfServings: 4,
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 2),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId: stewId,
        numberOfServings: 4,
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      const line = result.categories[0]?.lines[0];
      expect(line?.totalQuantity).toBe('3.000');
      expect(line?.contributingSlots).toHaveLength(2);
      expect(line?.contributingSlots.map((c) => c.recipeName)).toEqual([
        'Curry',
        'Stew',
      ]);
    });

    it('collapses within-slot duplicate ingredient lines into one contributing slot', async () => {
      // Onion sliced + onion diced on one recipe.
      const onionId = await insertIngredient('Onion');
      const recipeId = await insertRecipe('Stir-fry', { baseServings: 4 });
      await insertRecipeIngredient(recipeId, onionId, '1.000');
      await insertRecipeIngredient(recipeId, onionId, '1.000');

      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 4,
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      const line = result.categories[0]?.lines[0];
      expect(line?.totalQuantity).toBe('2.000');
      expect(line?.contributingSlots).toHaveLength(1);
      expect(line?.contributingSlots[0]?.scaledQuantity).toBe('2.000');
    });

    it('returns empty categories when only non-recipe slots exist', async () => {
      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 2),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'eat_out',
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 2),
        occasionId: dinnerId,
        slotType: 'leftovers',
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      expect(result).toEqual({ planId, categories: [] });
    });

    it('excludes non-recipe slot ingredients alongside recipe slots', async () => {
      const onionId = await insertIngredient('Onion');
      const recipeId = await insertRecipe('Curry', { baseServings: 4 });
      await insertRecipeIngredient(recipeId, onionId, '2.000');

      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 2),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 4,
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 2),
        occasionId: dinnerId,
        slotType: 'eat_out',
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      const line = result.categories[0]?.lines[0];
      expect(line?.totalQuantity).toBe('2.000');
      expect(line?.contributingSlots).toHaveLength(1);
    });

    it('serving-variation meal alone contributes only its own ingredients', async () => {
      const onionId = await insertIngredient('Onion');
      const chickpeaId = await insertIngredient('Chickpea', {
        categoryId: pantryCategoryId,
        defaultUnitId: gramsUnitId,
      });

      // Base recipe: chickpea curry base.
      const baseId = await insertRecipe('Curry base', {
        baseServings: 4,
        isBase: true,
      });
      await insertRecipeIngredient(baseId, chickpeaId, '400.000');

      // Batch-version: chickpea bowls — only the accompaniment (onion).
      const batchId = await insertRecipe('Chickpea bowls', {
        baseServings: 2,
        baseRecipeId: baseId,
      });
      await insertRecipeIngredient(batchId, onionId, '1.000');

      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId: batchId,
        numberOfServings: 2,
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      // Only onion shows up — chickpea is absent because no slot cooks the base.
      const allIngredientNames = result.categories.flatMap((c) =>
        c.lines.map((l) => l.ingredient.name),
      );
      expect(allIngredientNames).toEqual(['Onion']);
    });

    it('serving-variation + base-cook on different slots adds without double-counting', async () => {
      const onionId = await insertIngredient('Onion');
      const chickpeaId = await insertIngredient('Chickpea', {
        categoryId: pantryCategoryId,
        defaultUnitId: gramsUnitId,
      });

      const baseId = await insertRecipe('Curry base', {
        baseServings: 4,
        isBase: true,
      });
      await insertRecipeIngredient(baseId, chickpeaId, '400.000');
      // Base also uses some onion — checks no-double-count when the batch
      // also has onion.
      await insertRecipeIngredient(baseId, onionId, '2.000');

      const batchId = await insertRecipe('Chickpea bowls', {
        baseServings: 2,
        baseRecipeId: baseId,
      });
      await insertRecipeIngredient(batchId, onionId, '1.000');

      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 2),
      });
      // Tuesday: cook base (and eat batch). Both servings = 2, base servings 4.
      const tuesdayId = await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId: batchId,
        numberOfServings: 2,
        cooksBaseRecipeId: baseId,
        cooksBaseServings: 4,
      });
      // Wednesday: eat batch from leftovers.
      const wednesdayId = await insertSlot({
        planId,
        date: civilDate(2026, 1, 2),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId: batchId,
        numberOfServings: 2,
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });

      const allIngredients: Record<string, string> = {};
      for (const cat of result.categories) {
        for (const line of cat.lines) {
          allIngredients[line.ingredient.name] = line.totalQuantity;
        }
      }
      // Chickpea: 400 × (4/4) = 400 — base only.
      expect(allIngredients.Chickpea).toBe('400.000');
      // Onion: batch contributes 1×(2/2) + 1×(2/2) = 2; base cook contributes
      // 2×(4/4) = 2. Total 4. No double-count of the base onion via the meal
      // path (the batch's `base_recipe_id` doesn't recurse).
      expect(allIngredients.Onion).toBe('4.000');

      // Same slot (tuesday) appears twice in the onion line: once as batch
      // contribution, once as base contribution — different recipeIds.
      const onionLine = result.categories
        .flatMap((c) => c.lines)
        .find((l) => l.ingredient.name === 'Onion');
      const tuesdayContribs = onionLine?.contributingSlots.filter(
        (c) => c.slotId === tuesdayId,
      );
      expect(tuesdayContribs).toHaveLength(2);
      expect(tuesdayContribs?.map((c) => c.recipeName).sort()).toEqual([
        'Chickpea bowls',
        'Curry base',
      ]);
      // Wednesday slot contributes once (batch only).
      const wednesdayContribs = onionLine?.contributingSlots.filter(
        (c) => c.slotId === wednesdayId,
      );
      expect(wednesdayContribs).toHaveLength(1);
      expect(wednesdayContribs?.[0]?.recipeName).toBe('Chickpea bowls');
    });

    it('scales cooks-base contribution by cooksBaseServings / base.baseServings', async () => {
      const flourId = await insertIngredient('Flour', {
        categoryId: pantryCategoryId,
        defaultUnitId: gramsUnitId,
      });
      const baseId = await insertRecipe('Dough', {
        baseServings: 4,
        isBase: true,
      });
      await insertRecipeIngredient(baseId, flourId, '400.000');

      // Use a non-base recipe to fill the eating slot.
      const mealId = await insertRecipe('Pizza', { baseServings: 2 });

      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      // cooks_base_servings=10 against baseServings=4 → 2.5× scaling.
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId: mealId,
        numberOfServings: 2,
        cooksBaseRecipeId: baseId,
        cooksBaseServings: 10,
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      const flourLine = result.categories
        .flatMap((c) => c.lines)
        .find((l) => l.ingredient.name === 'Flour');
      // 400 × (10/4) = 1000
      expect(flourLine?.totalQuantity).toBe('1000.000');
      expect(flourLine?.contributingSlots[0]?.recipeName).toBe('Dough');
    });

    it('still includes ingredients from a soft-deleted recipe', async () => {
      const onionId = await insertIngredient('Onion');
      const recipeId = await insertRecipe('Curry', {
        baseServings: 4,
        isDeleted: true,
      });
      await insertRecipeIngredient(recipeId, onionId, '2.000');

      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 4,
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      const line = result.categories[0]?.lines[0];
      expect(line?.totalQuantity).toBe('2.000');
    });

    it('groups ingredients by category and orders by category then ingredient name', async () => {
      const onionId = await insertIngredient('Onion', {
        categoryId: produceCategoryId,
      });
      const carrotId = await insertIngredient('Carrot', {
        categoryId: produceCategoryId,
      });
      const flourId = await insertIngredient('Flour', {
        categoryId: pantryCategoryId,
        defaultUnitId: gramsUnitId,
      });

      const recipeId = await insertRecipe('Stew', { baseServings: 4 });
      await insertRecipeIngredient(recipeId, onionId, '1.000');
      await insertRecipeIngredient(recipeId, carrotId, '1.000');
      await insertRecipeIngredient(recipeId, flourId, '100.000');

      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 4,
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      expect(result.categories.map((c) => c.category.name)).toEqual([
        'Pantry',
        'Produce',
      ]);
      const produceLines = result.categories[1]?.lines.map(
        (l) => l.ingredient.name,
      );
      expect(produceLines).toEqual(['Carrot', 'Onion']);
    });

    it('throws NOT_FOUND for a plan belonging to another household', async () => {
      const otherPlanId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
        householdId: OTHER_HOUSEHOLD_ID,
      });

      await expect(
        createCaller(makeContext()).shopping.getForPlan({
          planId: otherPlanId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws NOT_FOUND for an unknown planId', async () => {
      await expect(
        createCaller(makeContext()).shopping.getForPlan({ planId: 999_999 }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects unauthenticated callers with UNAUTHORIZED', async () => {
      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      await expect(
        createCaller(makeContext({ authenticated: false })).shopping.getForPlan(
          { planId },
        ),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('getForPlan check-state', () => {
    async function buildOnionCurryPlan(options?: {
      numberOfServings?: number;
    }): Promise<{ planId: number; onionId: number; recipeId: number }> {
      const onionId = await insertIngredient('Onion');
      const recipeId = await insertRecipe('Curry', { baseServings: 4 });
      await insertRecipeIngredient(recipeId, onionId, '2.000');
      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: options?.numberOfServings ?? 4,
      });
      return { planId, onionId, recipeId };
    }

    it('lazy-creates one row per aggregated ingredient on first call', async () => {
      const onionId = await insertIngredient('Onion');
      const carrotId = await insertIngredient('Carrot');
      const recipeId = await insertRecipe('Stew', { baseServings: 4 });
      await insertRecipeIngredient(recipeId, onionId, '2.000');
      await insertRecipeIngredient(recipeId, carrotId, '3.000');
      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 4,
      });

      const before = await db.select().from(shoppingListItems);
      expect(before).toEqual([]);

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });

      const lines = result.categories.flatMap((c) => c.lines);
      expect(lines.every((line) => !line.isChecked)).toBe(true);

      const after = await db.select().from(shoppingListItems);
      expect(after).toHaveLength(2);
      expect(after.every((row) => !row.isChecked)).toBe(true);
      expect(after.every((row) => row.lastCheckedQuantity === null)).toBe(true);
      expect(
        after.map((row) => row.ingredientId).sort((a, b) => a - b),
      ).toEqual([onionId, carrotId].sort((a, b) => a - b));
    });

    it('is idempotent — calling twice does not duplicate rows', async () => {
      const { planId } = await buildOnionCurryPlan();
      await createCaller(makeContext()).shopping.getForPlan({ planId });
      await createCaller(makeContext()).shopping.getForPlan({ planId });
      const rows = await db.select().from(shoppingListItems);
      expect(rows).toHaveLength(1);
    });

    it('surfaces persisted check state without resetting when total matches', async () => {
      const { planId, onionId } = await buildOnionCurryPlan();
      // First call lazy-creates the row.
      await createCaller(makeContext()).shopping.getForPlan({ planId });
      // Seed it to checked with a matching total (current is '2.000' at
      // baseServings 4, numberOfServings 4).
      await db
        .update(shoppingListItems)
        .set({ isChecked: true, lastCheckedQuantity: '2.000' })
        .where(eq(shoppingListItems.ingredientId, onionId));

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      const line = result.categories[0]?.lines[0];
      expect(line?.isChecked).toBe(true);

      const persisted = await db
        .select()
        .from(shoppingListItems)
        .where(eq(shoppingListItems.ingredientId, onionId));
      expect(persisted[0]?.isChecked).toBe(true);
      expect(persisted[0]?.lastCheckedQuantity).toBe('2.000');
    });

    it('resets check-state when current total grows past last-checked', async () => {
      const { planId, onionId } = await buildOnionCurryPlan();
      await createCaller(makeContext()).shopping.getForPlan({ planId });
      await db
        .update(shoppingListItems)
        .set({ isChecked: true, lastCheckedQuantity: '2.000' })
        .where(eq(shoppingListItems.ingredientId, onionId));
      // Bump the eat item to 8 servings → 4.000 total.
      await db
        .update(mealPlanSlotItems)
        .set({ prepared: 8 })
        .where(
          and(
            sql`${mealPlanSlotItems.eaten} > 0`,
            inArray(
              mealPlanSlotItems.slotId,
              db
                .select({ id: mealPlanSlots.id })
                .from(mealPlanSlots)
                .where(eq(mealPlanSlots.planId, planId)),
            ),
          ),
        );

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      const line = result.categories[0]?.lines[0];
      expect(line?.isChecked).toBe(false);
      expect(line?.totalQuantity).toBe('4.000');

      const persisted = await db
        .select()
        .from(shoppingListItems)
        .where(eq(shoppingListItems.ingredientId, onionId));
      expect(persisted[0]?.isChecked).toBe(false);
      expect(persisted[0]?.lastCheckedQuantity).toBeNull();
    });

    it('resets check-state when current total shrinks below last-checked', async () => {
      const { planId, onionId } = await buildOnionCurryPlan();
      await createCaller(makeContext()).shopping.getForPlan({ planId });
      await db
        .update(shoppingListItems)
        .set({ isChecked: true, lastCheckedQuantity: '2.000' })
        .where(eq(shoppingListItems.ingredientId, onionId));
      await db
        .update(mealPlanSlotItems)
        .set({ prepared: 2 })
        .where(
          and(
            sql`${mealPlanSlotItems.eaten} > 0`,
            inArray(
              mealPlanSlotItems.slotId,
              db
                .select({ id: mealPlanSlots.id })
                .from(mealPlanSlots)
                .where(eq(mealPlanSlots.planId, planId)),
            ),
          ),
        );

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      const line = result.categories[0]?.lines[0];
      expect(line?.isChecked).toBe(false);
      expect(line?.totalQuantity).toBe('1.000');
    });

    it('does not reset other lines when one ingredient changes', async () => {
      const onionId = await insertIngredient('Onion');
      const carrotId = await insertIngredient('Carrot');
      const recipeId = await insertRecipe('Stew', { baseServings: 4 });
      await insertRecipeIngredient(recipeId, onionId, '2.000');
      await insertRecipeIngredient(recipeId, carrotId, '3.000');
      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      const slotId = await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 4,
      });
      await createCaller(makeContext()).shopping.getForPlan({ planId });
      // Check both at their current totals.
      await db
        .update(shoppingListItems)
        .set({ isChecked: true, lastCheckedQuantity: '2.000' })
        .where(eq(shoppingListItems.ingredientId, onionId));
      await db
        .update(shoppingListItems)
        .set({ isChecked: true, lastCheckedQuantity: '3.000' })
        .where(eq(shoppingListItems.ingredientId, carrotId));
      // Add a second slot that touches only Onion via a new recipe.
      const onionOnlyId = await insertRecipe('Onion soup', { baseServings: 2 });
      await insertRecipeIngredient(onionOnlyId, onionId, '1.000');
      await db
        .update(mealPlanSlotItems)
        .set({ prepared: 4 })
        .where(
          and(
            sql`${mealPlanSlotItems.eaten} > 0`,
            eq(mealPlanSlotItems.slotId, slotId),
          ),
        );
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: lunchId,
        slotType: 'recipe',
        recipeId: onionOnlyId,
        numberOfServings: 2,
      });

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      const allLines = result.categories.flatMap((c) => c.lines);
      const onionLine = allLines.find((l) => l.ingredient.id === onionId);
      const carrotLine = allLines.find((l) => l.ingredient.id === carrotId);
      // Onion total moved to 3.000; reset to false.
      expect(onionLine?.totalQuantity).toBe('3.000');
      expect(onionLine?.isChecked).toBe(false);
      // Carrot total unchanged at 3.000; check preserved.
      expect(carrotLine?.totalQuantity).toBe('3.000');
      expect(carrotLine?.isChecked).toBe(true);
    });

    it('compares lastCheckedQuantity by numeric value, not string representation', async () => {
      const { planId, onionId } = await buildOnionCurryPlan();
      await createCaller(makeContext()).shopping.getForPlan({ planId });
      // Postgres can emit "1.5" or "1.500" for the same numeric value;
      // seed the lopsided form and confirm no reset fires when the current
      // total is "2.000" vs stored "2.0".
      await db
        .update(shoppingListItems)
        .set({ isChecked: true, lastCheckedQuantity: '2.0' })
        .where(eq(shoppingListItems.ingredientId, onionId));

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      expect(result.categories[0]?.lines[0]?.isChecked).toBe(true);
    });

    it('does not affect rows whose ingredient no longer contributes to the plan', async () => {
      const { planId, onionId, recipeId } = await buildOnionCurryPlan();
      await createCaller(makeContext()).shopping.getForPlan({ planId });
      await db
        .update(shoppingListItems)
        .set({ isChecked: true, lastCheckedQuantity: '2.000' })
        .where(eq(shoppingListItems.ingredientId, onionId));
      // Remove the only recipe ingredient. Onion no longer contributes; the
      // row stays put.
      await db
        .delete(recipeIngredients)
        .where(eq(recipeIngredients.recipeId, recipeId));

      const result = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      expect(result.categories).toEqual([]);

      const persisted = await db.select().from(shoppingListItems);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.isChecked).toBe(true);
      expect(persisted[0]?.lastCheckedQuantity).toBe('2.000');
    });

    it('does not lazy-create rows in another household', async () => {
      const { planId } = await buildOnionCurryPlan();
      await createCaller(makeContext()).shopping.getForPlan({ planId });

      // Bare assertion that there is exactly one row for this plan and that
      // no rows leaked to a sibling household plan that does not exist.
      const rows = await db.select().from(shoppingListItems);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.planId).toBe(planId);
    });
  });

  describe('toggleChecked', () => {
    async function setupPlanWithIngredient(): Promise<{
      planId: number;
      onionId: number;
    }> {
      const onionId = await insertIngredient('Onion');
      const recipeId = await insertRecipe('Curry', { baseServings: 4 });
      await insertRecipeIngredient(recipeId, onionId, '2.500');
      const planId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
      });
      await insertSlot({
        planId,
        date: civilDate(2026, 1, 1),
        occasionId: dinnerId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 4,
      });
      return { planId, onionId };
    }

    it('records current total when checking a line for the first time', async () => {
      const { planId, onionId } = await setupPlanWithIngredient();
      // First, run getForPlan so the row exists (lazy-create).
      await createCaller(makeContext()).shopping.getForPlan({ planId });

      const result = await createCaller(makeContext()).shopping.toggleChecked({
        planId,
        ingredientId: onionId,
        isChecked: true,
      });
      expect(result).toEqual({
        planId,
        ingredientId: onionId,
        isChecked: true,
      });

      const row = await db
        .select()
        .from(shoppingListItems)
        .where(eq(shoppingListItems.ingredientId, onionId));
      expect(row[0]?.isChecked).toBe(true);
      expect(row[0]?.lastCheckedQuantity).toBe('2.500');
    });

    it('clears lastCheckedQuantity when unchecking', async () => {
      const { planId, onionId } = await setupPlanWithIngredient();
      await createCaller(makeContext()).shopping.getForPlan({ planId });
      await createCaller(makeContext()).shopping.toggleChecked({
        planId,
        ingredientId: onionId,
        isChecked: true,
      });
      await createCaller(makeContext()).shopping.toggleChecked({
        planId,
        ingredientId: onionId,
        isChecked: false,
      });

      const row = await db
        .select()
        .from(shoppingListItems)
        .where(eq(shoppingListItems.ingredientId, onionId));
      expect(row[0]?.isChecked).toBe(false);
      expect(row[0]?.lastCheckedQuantity).toBeNull();
    });

    it('upserts on first toggle when no row exists yet', async () => {
      const { planId, onionId } = await setupPlanWithIngredient();
      // No getForPlan first — caller toggles directly.
      const before = await db.select().from(shoppingListItems);
      expect(before).toEqual([]);

      await createCaller(makeContext()).shopping.toggleChecked({
        planId,
        ingredientId: onionId,
        isChecked: true,
      });

      const after = await db.select().from(shoppingListItems);
      expect(after).toHaveLength(1);
      expect(after[0]?.isChecked).toBe(true);
      expect(after[0]?.lastCheckedQuantity).toBe('2.500');
    });

    it('throws NOT_FOUND for a plan belonging to another household', async () => {
      const onionId = await insertIngredient('Onion');
      const otherPlanId = await insertPlan({
        startDate: civilDate(2026, 1, 1),
        endDate: civilDate(2026, 1, 1),
        householdId: OTHER_HOUSEHOLD_ID,
      });
      await expect(
        createCaller(makeContext()).shopping.toggleChecked({
          planId: otherPlanId,
          ingredientId: onionId,
          isChecked: true,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws NOT_FOUND for an ingredient that does not contribute to the plan', async () => {
      const { planId } = await setupPlanWithIngredient();
      const carrotId = await insertIngredient('Carrot');
      await expect(
        createCaller(makeContext()).shopping.toggleChecked({
          planId,
          ingredientId: carrotId,
          isChecked: true,
        }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        cause: { code: 'SHOPPING_INGREDIENT_NOT_IN_PLAN' },
      });

      const rows = await db.select().from(shoppingListItems);
      expect(rows).toEqual([]);
    });

    it('round-trips through getForPlan: toggled state is reflected on next read', async () => {
      const { planId, onionId } = await setupPlanWithIngredient();
      await createCaller(makeContext()).shopping.toggleChecked({
        planId,
        ingredientId: onionId,
        isChecked: true,
      });
      const checked = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      expect(checked.categories[0]?.lines[0]?.isChecked).toBe(true);

      await createCaller(makeContext()).shopping.toggleChecked({
        planId,
        ingredientId: onionId,
        isChecked: false,
      });
      const unchecked = await createCaller(makeContext()).shopping.getForPlan({
        planId,
      });
      expect(unchecked.categories[0]?.lines[0]?.isChecked).toBe(false);
    });

    it('advances updatedAt on every write', async () => {
      const { planId, onionId } = await setupPlanWithIngredient();
      await createCaller(makeContext()).shopping.toggleChecked({
        planId,
        ingredientId: onionId,
        isChecked: true,
      });
      const first = await db
        .select()
        .from(shoppingListItems)
        .where(eq(shoppingListItems.ingredientId, onionId));
      const firstUpdatedAt = first[0]?.updatedAt;
      if (!firstUpdatedAt) throw new Error('expected updatedAt on first read');

      await new Promise((resolve) => setTimeout(resolve, 10));
      await createCaller(makeContext()).shopping.toggleChecked({
        planId,
        ingredientId: onionId,
        isChecked: false,
      });
      const second = await db
        .select()
        .from(shoppingListItems)
        .where(eq(shoppingListItems.ingredientId, onionId));
      const secondUpdatedAt = second[0]?.updatedAt;
      if (!secondUpdatedAt) {
        throw new Error('expected updatedAt on second read');
      }
      expect(secondUpdatedAt.getTime()).toBeGreaterThan(
        firstUpdatedAt.getTime(),
      );
    });
  });
});
