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
  recipeComments,
  recipeRatings,
  relatedRecipes,
} from '../src/db/schema/recipe-social.ts';
import {
  recipeIngredients,
  recipeMethod,
  recipeSources,
  recipes,
} from '../src/db/schema/recipes.ts';
import {
  ingredientCategories,
  preparationTypes,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { selectRecipePlantPoints } from '../src/lib/plant-points.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { appRouter } from '../src/trpc/router.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const USER_ID = 'user-recipes-test-1';
const OTHER_USER_ID = 'user-recipes-test-2';
const USER_EMAIL = 'rtest@example.com';
const OTHER_USER_EMAIL = 'rtest2@example.com';
const SESSION_ID = 'session-recipes-test-1';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009aa';

describe('recipes procedures', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;
  let categoryId!: number;
  let unitG!: number;
  let prepChopped!: number;
  let prepDiced!: number;

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
        ${relatedRecipes},
        ${recipeMethod},
        ${recipeIngredients},
        ${recipes},
        ${recipeSources},
        ${ingredients},
        ${preparationTypes},
        ${ingredientCategories},
        ${unitsOfMeasurement},
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
        name: 'Recipe Tester',
        emailVerified: true,
      },
      {
        id: OTHER_USER_ID,
        email: OTHER_USER_EMAIL,
        name: 'Other Tester',
        emailVerified: true,
      },
    ]);
    const cats = await db
      .insert(ingredientCategories)
      .values([{ name: 'Fruit & Veg' }])
      .returning();
    const cat = cats[0];
    if (!cat) throw new Error('category seed failed');
    categoryId = cat.id;
    const units = await db
      .insert(unitsOfMeasurement)
      .values([{ name: 'g' }, { name: 'piece' }])
      .returning();
    const [u0, u1] = units;
    if (!u0 || !u1) throw new Error('unit seed failed');
    unitG = u0.id;
    const preps = await db
      .insert(preparationTypes)
      .values([{ name: 'chopped' }, { name: 'diced' }])
      .returning();
    const [p0, p1] = preps;
    if (!p0 || !p1) throw new Error('prep seed failed');
    prepChopped = p0.id;
    prepDiced = p1.id;
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

  interface InsertIngredientOptions {
    name: string;
    isPlant?: boolean;
    unitId?: number;
  }
  async function insertIngredient(
    options: InsertIngredientOptions,
  ): Promise<number> {
    const inserted = await db
      .insert(ingredients)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name: options.name,
        categoryId,
        defaultUnitId: options.unitId ?? unitG,
        isPlant: options.isPlant ?? false,
      })
      .returning({ id: ingredients.id });
    const row = inserted[0];
    if (!row) throw new Error('ingredient insert failed');
    return row.id;
  }

  interface InsertRecipeOptions {
    name: string;
    householdId?: string;
    isDeleted?: boolean;
    isBase?: boolean;
    description?: string;
    sourceId?: number;
    sourceUrl?: string;
    imageUrl?: string;
  }
  async function insertRecipe(options: InsertRecipeOptions): Promise<number> {
    const inserted = await db
      .insert(recipes)
      .values({
        householdId: options.householdId ?? CURRENT_HOUSEHOLD_ID,
        name: options.name,
        description: options.description,
        baseServings: 2,
        isDeleted: options.isDeleted ?? false,
        isBase: options.isBase ?? false,
        sourceId: options.sourceId,
        sourceUrl: options.sourceUrl,
        imageUrl: options.imageUrl,
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
    options: { quantity?: string; prepTypeId?: number } = {},
  ): Promise<void> {
    await db.insert(recipeIngredients).values({
      recipeId,
      ingredientId,
      quantity: options.quantity ?? '100',
      prepTypeId: options.prepTypeId,
    });
  }

  describe('list', () => {
    it('returns recipes for the current household only', async () => {
      await insertRecipe({ name: 'Aloo Gobi' });
      await insertRecipe({
        name: 'Other Curry',
        householdId: OTHER_HOUSEHOLD_ID,
      });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.list();

      expect(result.items.map((r) => r.name)).toEqual(['Aloo Gobi']);
    });

    it('hides soft-deleted recipes by default', async () => {
      await insertRecipe({ name: 'Active' });
      await insertRecipe({ name: 'Soft Deleted', isDeleted: true });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.list();

      expect(result.items.map((r) => r.name)).toEqual(['Active']);
    });

    it('returns soft-deleted recipes when includeDeleted is true', async () => {
      await insertRecipe({ name: 'Active' });
      await insertRecipe({ name: 'Soft Deleted', isDeleted: true });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.list({ includeDeleted: true });

      expect(result.items.map((r) => r.name).sort()).toEqual([
        'Active',
        'Soft Deleted',
      ]);
    });

    it('filters by case-insensitive substring search', async () => {
      await insertRecipe({ name: 'Onion Bhaji' });
      await insertRecipe({ name: 'Spring Onion Salad' });
      await insertRecipe({ name: 'Carrot Cake' });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.list({ search: 'ONI' });

      expect(result.items.map((r) => r.name).sort()).toEqual([
        'Onion Bhaji',
        'Spring Onion Salad',
      ]);
    });

    it('orders deterministically by lowered name then id', async () => {
      await insertRecipe({ name: 'banana split' });
      await insertRecipe({ name: 'Apple pie' });
      await insertRecipe({ name: 'Apple pie' });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.list();

      expect(result.items.map((r) => r.name)).toEqual([
        'Apple pie',
        'Apple pie',
        'banana split',
      ]);
      const [first, second] = result.items;
      if (!first || !second) throw new Error('expected two leading rows');
      expect(first.id).toBeLessThan(second.id);
    });

    it('keyset cursor returns the next page and null when exhausted', async () => {
      await insertRecipe({ name: 'A' });
      await insertRecipe({ name: 'B' });
      await insertRecipe({ name: 'C' });

      const caller = createCaller(makeContext());
      const first = await caller.recipes.list({ limit: 2 });
      expect(first.items.map((r) => r.name)).toEqual(['A', 'B']);
      expect(first.nextCursor).not.toBeNull();

      const second = await caller.recipes.list({
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((r) => r.name)).toEqual(['C']);
      expect(second.nextCursor).toBeNull();
    });

    it('computes plantPointsCount from distinct plant ingredients', async () => {
      const onion = await insertIngredient({ name: 'Onion', isPlant: true });
      const garlic = await insertIngredient({ name: 'Garlic', isPlant: true });
      const butter = await insertIngredient({ name: 'Butter', isPlant: false });
      const recipeId = await insertRecipe({ name: 'Demo' });
      await insertRecipeIngredient(recipeId, onion, {
        prepTypeId: prepChopped,
      });
      await insertRecipeIngredient(recipeId, onion, { prepTypeId: prepDiced });
      await insertRecipeIngredient(recipeId, garlic);
      await insertRecipeIngredient(recipeId, butter);

      const caller = createCaller(makeContext());
      const result = await caller.recipes.list();
      const recipe = result.items.find((r) => r.id === recipeId);
      expect(recipe?.plantPointsCount).toBe(2);
    });

    it('rejects without a session', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(caller.recipes.list()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('get', () => {
    it('returns the full joined detail shape', async () => {
      const onion = await insertIngredient({ name: 'Onion', isPlant: true });
      const butter = await insertIngredient({
        name: 'Butter',
        isPlant: false,
        unitId: unitG,
      });
      const insertedSource = await db
        .insert(recipeSources)
        .values({ householdId: CURRENT_HOUSEHOLD_ID, name: 'Mob Kitchen' })
        .returning({ id: recipeSources.id });
      const sourceRow = insertedSource[0];
      if (!sourceRow) throw new Error('source seed failed');
      const recipeId = await insertRecipe({
        name: 'Onion Soup',
        description: 'A simple soup.',
        sourceId: sourceRow.id,
        sourceUrl: 'https://example.test/onion-soup',
      });
      await insertRecipeIngredient(recipeId, onion, {
        quantity: '300',
        prepTypeId: prepChopped,
      });
      await insertRecipeIngredient(recipeId, butter, { quantity: '50' });
      await db.insert(recipeMethod).values([
        { recipeId, stepNumber: 2, instruction: 'Simmer.' },
        { recipeId, stepNumber: 1, instruction: 'Sauté onions.' },
      ]);

      const caller = createCaller(makeContext());
      const result = await caller.recipes.get({ id: recipeId });

      expect(result).toMatchObject({
        id: recipeId,
        name: 'Onion Soup',
        description: 'A simple soup.',
        sourceName: 'Mob Kitchen',
        sourceUrl: 'https://example.test/onion-soup',
        plantPointsCount: 1,
      });
      expect(result.method.map((m) => m.instruction)).toEqual([
        'Sauté onions.',
        'Simmer.',
      ]);
      expect(result.ingredients).toHaveLength(2);
      const onionLine = result.ingredients.find(
        (i) => i.ingredientName === 'Onion',
      );
      expect(onionLine).toMatchObject({
        unitName: 'g',
        prepTypeName: 'chopped',
        isPlant: true,
        quantity: '300.000',
      });
    });

    it('returns soft-deleted recipes (historical rendering)', async () => {
      const recipeId = await insertRecipe({
        name: 'Tombstoned',
        isDeleted: true,
      });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.get({ id: recipeId });

      expect(result.id).toBe(recipeId);
      expect(result.isDeleted).toBe(true);
    });

    it('returns NOT_FOUND for a missing id', async () => {
      const caller = createCaller(makeContext());
      await expect(caller.recipes.get({ id: 9999 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('returns NOT_FOUND for a recipe in another household', async () => {
      const recipeId = await insertRecipe({
        name: 'Other',
        householdId: OTHER_HOUSEHOLD_ID,
      });

      const caller = createCaller(makeContext());
      await expect(caller.recipes.get({ id: recipeId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('returns null aggregates when there are no ratings', async () => {
      const recipeId = await insertRecipe({ name: 'Unrated' });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.get({ id: recipeId });

      expect(result.averageRating).toBeNull();
      expect(result.ratingCount).toBe(0);
      expect(result.yourRating).toBeNull();
    });

    it('aggregates ratings and surfaces the caller’s own rating', async () => {
      const recipeId = await insertRecipe({ name: 'Rated' });
      await db.insert(recipeRatings).values([
        { recipeId, userId: USER_ID, rating: 4 },
        { recipeId, userId: OTHER_USER_ID, rating: 2 },
      ]);

      const caller = createCaller(makeContext());
      const result = await caller.recipes.get({ id: recipeId });

      expect(result.ratingCount).toBe(2);
      expect(result.averageRating).toBe(3);
      expect(result.yourRating).toBe(4);

      const otherCaller = createCaller(makeContext({ userId: OTHER_USER_ID }));
      const otherResult = await otherCaller.recipes.get({ id: recipeId });
      expect(otherResult.yourRating).toBe(2);
    });

    it('rejects without a session', async () => {
      const recipeId = await insertRecipe({ name: 'X' });
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(caller.recipes.get({ id: recipeId })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('selectRecipePlantPoints', () => {
    it('counts distinct plants and ignores non-plants', async () => {
      const onion = await insertIngredient({ name: 'Onion', isPlant: true });
      const garlic = await insertIngredient({ name: 'Garlic', isPlant: true });
      const butter = await insertIngredient({ name: 'Butter', isPlant: false });
      const recipeId = await insertRecipe({ name: 'Demo' });
      await insertRecipeIngredient(recipeId, onion, {
        prepTypeId: prepChopped,
      });
      await insertRecipeIngredient(recipeId, onion, { prepTypeId: prepDiced });
      await insertRecipeIngredient(recipeId, garlic);
      await insertRecipeIngredient(recipeId, butter);

      const points = await selectRecipePlantPoints(db, recipeId);
      expect(points).toBe(2);
    });

    it('returns 0 for a recipe with no plant ingredients', async () => {
      const butter = await insertIngredient({ name: 'Butter', isPlant: false });
      const recipeId = await insertRecipe({ name: 'Demo' });
      await insertRecipeIngredient(recipeId, butter);

      const points = await selectRecipePlantPoints(db, recipeId);
      expect(points).toBe(0);
    });
  });
});
