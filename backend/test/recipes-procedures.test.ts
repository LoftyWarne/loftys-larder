import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { asc, eq, sql } from 'drizzle-orm';
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
    baseRecipeId?: number;
    pairedRecipeId?: number;
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
        baseRecipeId: options.baseRecipeId,
        pairedRecipeId: options.pairedRecipeId,
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

  describe('references', () => {
    it('returns units and prep types alphabetically', async () => {
      const caller = createCaller(makeContext());
      const result = await caller.recipes.references();
      expect(result.units.map((u) => u.name)).toEqual(['g', 'piece']);
      expect(result.prepTypes.map((p) => p.name)).toEqual(['chopped', 'diced']);
    });

    it('returns sources only for the current household', async () => {
      const inserted = await db
        .insert(recipeSources)
        .values([
          { householdId: CURRENT_HOUSEHOLD_ID, name: 'BBC Good Food' },
          { householdId: CURRENT_HOUSEHOLD_ID, name: 'Mob' },
          { householdId: OTHER_HOUSEHOLD_ID, name: 'Other Cookbook' },
        ])
        .returning();
      expect(inserted).toHaveLength(3);

      const caller = createCaller(makeContext());
      const result = await caller.recipes.references();
      expect(result.sources.map((s) => s.name)).toEqual([
        'BBC Good Food',
        'Mob',
      ]);
    });

    it('rejects unauthenticated callers', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(caller.recipes.references()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

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

  describe('create', () => {
    it('inserts a minimal recipe and returns the new id', async () => {
      const caller = createCaller(makeContext());
      const result = await caller.recipes.create({
        name: 'Tomato Soup',
        baseServings: 4,
      });

      expect(result.id).toBeGreaterThan(0);

      const rows = await db
        .select()
        .from(recipes)
        .where(eq(recipes.id, result.id));
      const row = rows[0];
      if (!row) throw new Error('recipe row missing');
      expect(row.name).toBe('Tomato Soup');
      expect(row.baseServings).toBe(4);
      expect(row.householdId).toBe(CURRENT_HOUSEHOLD_ID);
      expect(row.addedByUserId).toBe(USER_ID);
      expect(row.isBase).toBe(false);
      expect(row.isDeleted).toBe(false);
    });

    it('persists optional fields when provided', async () => {
      const caller = createCaller(makeContext());
      const result = await caller.recipes.create({
        name: 'Lentil Dal',
        baseServings: 2,
        description: 'Comforting weeknight dal.',
        imageUrl: 'https://res.cloudinary.test/img/lentil.jpg',
        activeTimeMins: 20,
        totalTimeMins: 45,
        estimatedCostPerServing: '1.75',
        caloriesPerServing: 410,
        proteinPerServing: 18,
        sourceUrl: 'https://example.test/lentil-dal',
      });

      const rows = await db
        .select()
        .from(recipes)
        .where(eq(recipes.id, result.id));
      const row = rows[0];
      if (!row) throw new Error('recipe row missing');
      expect(row.description).toBe('Comforting weeknight dal.');
      expect(row.activeTimeMins).toBe(20);
      expect(row.totalTimeMins).toBe(45);
      expect(row.estimatedCostPerServing).toBe('1.75');
      expect(row.caloriesPerServing).toBe(410);
      expect(row.proteinPerServing).toBe(18);
      expect(row.sourceUrl).toBe('https://example.test/lentil-dal');
    });

    it('creates a base recipe when isBase is true', async () => {
      const caller = createCaller(makeContext());
      const result = await caller.recipes.create({
        name: 'Slow-Cooked Beans',
        baseServings: 8,
        isBase: true,
      });

      const rows = await db
        .select({ isBase: recipes.isBase })
        .from(recipes)
        .where(eq(recipes.id, result.id));
      expect(rows[0]?.isBase).toBe(true);
    });

    it('rejects baseServings below 1 at the boundary', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.create({ name: 'Bad', baseServings: 0 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects an empty name', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.create({ name: '   ', baseServings: 2 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects without a session', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.recipes.create({ name: 'X', baseServings: 1 }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('rejects a sourceId belonging to another household', async () => {
      const inserted = await db
        .insert(recipeSources)
        .values({ householdId: OTHER_HOUSEHOLD_ID, name: 'Foreign Cookbook' })
        .returning({ id: recipeSources.id });
      const foreignSourceId = inserted[0]?.id;
      if (!foreignSourceId) throw new Error('source seed failed');

      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.create({
          name: 'Cross-household source',
          baseServings: 2,
          sourceId: foreignSourceId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('updateHeader', () => {
    it('updates only the supplied fields', async () => {
      const recipeId = await insertRecipe({
        name: 'Original',
        description: 'Original description',
      });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.updateHeader({
        id: recipeId,
        patch: { name: 'Renamed' },
      });
      expect(result.id).toBe(recipeId);

      const rows = await db
        .select({
          name: recipes.name,
          description: recipes.description,
        })
        .from(recipes)
        .where(eq(recipes.id, recipeId));
      expect(rows[0]).toEqual({
        name: 'Renamed',
        description: 'Original description',
      });
    });

    it('clears a nullable column when null is supplied', async () => {
      const recipeId = await insertRecipe({
        name: 'WithDesc',
        description: 'Will be cleared',
      });

      const caller = createCaller(makeContext());
      await caller.recipes.updateHeader({
        id: recipeId,
        patch: { description: null },
      });

      const rows = await db
        .select({ description: recipes.description })
        .from(recipes)
        .where(eq(recipes.id, recipeId));
      expect(rows[0]?.description).toBeNull();
    });

    it('rejects an empty patch', async () => {
      const recipeId = await insertRecipe({ name: 'Any' });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.updateHeader({ id: recipeId, patch: {} }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('returns NOT_FOUND for a recipe in another household', async () => {
      const otherId = await insertRecipe({
        name: 'Other',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.updateHeader({
          id: otherId,
          patch: { name: 'Hacked' },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects a sourceId belonging to another household', async () => {
      const recipeId = await insertRecipe({ name: 'Recipe with source' });
      const inserted = await db
        .insert(recipeSources)
        .values({ householdId: OTHER_HOUSEHOLD_ID, name: 'Foreign Cookbook' })
        .returning({ id: recipeSources.id });
      const foreignSourceId = inserted[0]?.id;
      if (!foreignSourceId) throw new Error('source seed failed');

      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.updateHeader({
          id: recipeId,
          patch: { sourceId: foreignSourceId },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects unknown header fields (isBase, baseRecipeId, pairedRecipeId)', async () => {
      const recipeId = await insertRecipe({ name: 'Strict' });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.updateHeader({
          id: recipeId,
          // Use a structural cast — the type rejects these, the runtime check
          // confirms the boundary refuses them too.
          patch: { isBase: true } as unknown as Parameters<
            typeof caller.recipes.updateHeader
          >[0]['patch'],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('replaceIngredients', () => {
    it('replaces the full set in order', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      const onion = await insertIngredient({ name: 'Onion', isPlant: true });
      const garlic = await insertIngredient({ name: 'Garlic', isPlant: true });
      await insertRecipeIngredient(recipeId, onion, { quantity: '50' });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.replaceIngredients({
        recipeId,
        lines: [
          {
            ingredientId: garlic,
            quantity: '10',
            unitId: unitG,
            prepTypeId: null,
          },
          {
            ingredientId: onion,
            quantity: '200',
            unitId: unitG,
            prepTypeId: prepDiced,
          },
        ],
      });
      expect(result).toEqual({ recipeId, count: 2 });

      const rows = await db
        .select({
          ingredientId: recipeIngredients.ingredientId,
          quantity: recipeIngredients.quantity,
          prepTypeId: recipeIngredients.prepTypeId,
        })
        .from(recipeIngredients)
        .where(eq(recipeIngredients.recipeId, recipeId))
        .orderBy(asc(recipeIngredients.id));
      expect(rows).toEqual([
        { ingredientId: garlic, quantity: '10.000', prepTypeId: null },
        { ingredientId: onion, quantity: '200.000', prepTypeId: prepDiced },
      ]);
    });

    it('allows the same ingredient twice with different prep types', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      const onion = await insertIngredient({ name: 'Onion', isPlant: true });
      const caller = createCaller(makeContext());
      await caller.recipes.replaceIngredients({
        recipeId,
        lines: [
          {
            ingredientId: onion,
            quantity: '100',
            unitId: unitG,
            prepTypeId: prepChopped,
          },
          {
            ingredientId: onion,
            quantity: '50',
            unitId: unitG,
            prepTypeId: prepDiced,
          },
        ],
      });
      const rows = await db
        .select()
        .from(recipeIngredients)
        .where(eq(recipeIngredients.recipeId, recipeId));
      expect(rows).toHaveLength(2);
    });

    it('rejects unit mismatch with BAD_REQUEST + domain code', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      const onion = await insertIngredient({ name: 'Onion', isPlant: true });
      const piecesUnit = await db
        .select({ id: unitsOfMeasurement.id })
        .from(unitsOfMeasurement)
        .where(eq(unitsOfMeasurement.name, 'piece'));
      const pieceId = piecesUnit[0]?.id;
      if (!pieceId) throw new Error('piece unit not seeded');

      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.replaceIngredients({
          recipeId,
          lines: [
            {
              ingredientId: onion,
              quantity: '1',
              unitId: pieceId,
              prepTypeId: null,
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'RECIPE_INGREDIENT_UNIT_MISMATCH' },
      });
    });

    it('rejects an ingredient from another household', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      const inserted = await db
        .insert(ingredients)
        .values({
          householdId: OTHER_HOUSEHOLD_ID,
          name: 'Outsider',
          categoryId,
          defaultUnitId: unitG,
          isPlant: false,
        })
        .returning({ id: ingredients.id });
      const outsiderId = inserted[0]?.id;
      if (!outsiderId) throw new Error('outsider seed failed');

      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.replaceIngredients({
          recipeId,
          lines: [
            {
              ingredientId: outsiderId,
              quantity: '1',
              unitId: unitG,
              prepTypeId: null,
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'RECIPE_INGREDIENT_NOT_FOUND' },
      });
    });

    it('rolls back when the insert phase fails', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      const onion = await insertIngredient({ name: 'Onion', isPlant: true });
      await insertRecipeIngredient(recipeId, onion, { quantity: '111' });

      const caller = createCaller(makeContext());

      // The pre-flight validation guards the ingredient FK, so to simulate
      // an in-transaction failure we use a non-existent `prepTypeId`. The
      // FK fires inside the INSERT (after the DELETE) — a successful rollback
      // means the original `111` row survives.
      await expect(
        caller.recipes.replaceIngredients({
          recipeId,
          lines: [
            {
              ingredientId: onion,
              quantity: '999',
              unitId: unitG,
              prepTypeId: 99999,
            },
          ],
        }),
      ).rejects.toBeDefined();

      const rows = await db
        .select({ quantity: recipeIngredients.quantity })
        .from(recipeIngredients)
        .where(eq(recipeIngredients.recipeId, recipeId));
      expect(rows).toEqual([{ quantity: '111.000' }]);
    });

    it('clears all lines when an empty array is supplied', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      const onion = await insertIngredient({ name: 'Onion', isPlant: true });
      await insertRecipeIngredient(recipeId, onion);

      const caller = createCaller(makeContext());
      const result = await caller.recipes.replaceIngredients({
        recipeId,
        lines: [],
      });
      expect(result.count).toBe(0);

      const rows = await db
        .select()
        .from(recipeIngredients)
        .where(eq(recipeIngredients.recipeId, recipeId));
      expect(rows).toHaveLength(0);
    });

    it('returns NOT_FOUND for a recipe in another household', async () => {
      const otherId = await insertRecipe({
        name: 'Other',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.replaceIngredients({
          recipeId: otherId,
          lines: [],
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('replaceMethod', () => {
    it('replaces steps in order and renumbers from 1', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      await db.insert(recipeMethod).values({
        recipeId,
        stepNumber: 1,
        instruction: 'old step',
      });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.replaceMethod({
        recipeId,
        steps: [
          { instruction: 'first new step' },
          { instruction: 'second new step' },
          { instruction: 'third new step' },
        ],
      });
      expect(result).toEqual({ recipeId, count: 3 });

      const rows = await db
        .select({
          stepNumber: recipeMethod.stepNumber,
          instruction: recipeMethod.instruction,
        })
        .from(recipeMethod)
        .where(eq(recipeMethod.recipeId, recipeId))
        .orderBy(asc(recipeMethod.stepNumber));
      expect(rows).toEqual([
        { stepNumber: 1, instruction: 'first new step' },
        { stepNumber: 2, instruction: 'second new step' },
        { stepNumber: 3, instruction: 'third new step' },
      ]);
    });

    it('clears all steps when an empty array is supplied', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      await db.insert(recipeMethod).values({
        recipeId,
        stepNumber: 1,
        instruction: 'old step',
      });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.replaceMethod({
        recipeId,
        steps: [],
      });
      expect(result.count).toBe(0);

      const rows = await db
        .select()
        .from(recipeMethod)
        .where(eq(recipeMethod.recipeId, recipeId));
      expect(rows).toHaveLength(0);
    });

    it('returns NOT_FOUND for a recipe in another household', async () => {
      const otherId = await insertRecipe({
        name: 'Other',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.replaceMethod({ recipeId: otherId, steps: [] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects empty instruction text at the boundary', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.replaceMethod({
          recipeId,
          steps: [{ instruction: '   ' }],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('softDelete and restore', () => {
    it('soft-deletes and restores a recipe', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      const caller = createCaller(makeContext());

      const deleted = await caller.recipes.softDelete({ id: recipeId });
      expect(deleted).toEqual({ id: recipeId, isDeleted: true });

      const restored = await caller.recipes.restore({ id: recipeId });
      expect(restored).toEqual({ id: recipeId, isDeleted: false });
    });

    it('softDelete is idempotent', async () => {
      const recipeId = await insertRecipe({ name: 'Demo', isDeleted: true });
      const caller = createCaller(makeContext());
      const result = await caller.recipes.softDelete({ id: recipeId });
      expect(result).toEqual({ id: recipeId, isDeleted: true });
    });

    it('soft-deleted recipe is still returned by get (historical render)', async () => {
      const recipeId = await insertRecipe({ name: 'Demo' });
      const caller = createCaller(makeContext());
      await caller.recipes.softDelete({ id: recipeId });
      const fetched = await caller.recipes.get({ id: recipeId });
      expect(fetched.isDeleted).toBe(true);
    });

    it('soft-deleted recipe is hidden from list by default', async () => {
      const recipeId = await insertRecipe({ name: 'Hidden' });
      const caller = createCaller(makeContext());
      await caller.recipes.softDelete({ id: recipeId });

      const listed = await caller.recipes.list();
      expect(listed.items.find((r) => r.id === recipeId)).toBeUndefined();

      const withDeleted = await caller.recipes.list({ includeDeleted: true });
      expect(withDeleted.items.find((r) => r.id === recipeId)).toBeDefined();
    });

    it('returns NOT_FOUND for a recipe in another household', async () => {
      const otherId = await insertRecipe({
        name: 'Other',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.softDelete({ id: otherId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller.recipes.restore({ id: otherId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('setBatchFields', () => {
    async function readPair(recipeId: number): Promise<number | null> {
      const rows = await db
        .select({ pairedRecipeId: recipes.pairedRecipeId })
        .from(recipes)
        .where(eq(recipes.id, recipeId));
      return rows[0]?.pairedRecipeId ?? null;
    }

    it('marks a recipe as a base', async () => {
      const recipeId = await insertRecipe({ name: 'Stock' });
      const caller = createCaller(makeContext());
      const result = await caller.recipes.setBatchFields({
        id: recipeId,
        isBase: true,
      });
      expect(result.isBase).toBe(true);
      const rows = await db
        .select({ isBase: recipes.isBase })
        .from(recipes)
        .where(eq(recipes.id, recipeId));
      expect(rows[0]?.isBase).toBe(true);
    });

    it('rejects isBase=true with a non-null baseRecipeId', async () => {
      const base = await insertRecipe({ name: 'Beans', isBase: true });
      const child = await insertRecipe({
        name: 'Chilli',
        baseRecipeId: base,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.setBatchFields({ id: child, isBase: true }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'RECIPE_BATCH_XOR_VIOLATION' },
      });
    });

    it('points a recipe at a base', async () => {
      const base = await insertRecipe({ name: 'Beans', isBase: true });
      const child = await insertRecipe({ name: 'Chilli' });
      const caller = createCaller(makeContext());
      const result = await caller.recipes.setBatchFields({
        id: child,
        baseRecipeId: base,
      });
      expect(result.baseRecipeId).toBe(base);
    });

    it('rejects pointing at a non-base recipe', async () => {
      const notBase = await insertRecipe({ name: 'Regular' });
      const child = await insertRecipe({ name: 'Child' });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.setBatchFields({ id: child, baseRecipeId: notBase }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'RECIPE_BATCH_BASE_NOT_PICKABLE' },
      });
    });

    it('rejects pointing at a soft-deleted base', async () => {
      const base = await insertRecipe({
        name: 'Beans',
        isBase: true,
        isDeleted: true,
      });
      const child = await insertRecipe({ name: 'Child' });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.setBatchFields({ id: child, baseRecipeId: base }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'RECIPE_BATCH_BASE_NOT_PICKABLE' },
      });
    });

    it('rejects a base from another household as NOT_FOUND', async () => {
      const foreignBase = await insertRecipe({
        name: 'Foreign Base',
        isBase: true,
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const child = await insertRecipe({ name: 'Child' });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.setBatchFields({
          id: child,
          baseRecipeId: foreignBase,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'RECIPE_BATCH_BASE_NOT_FOUND' },
      });
    });

    it('pairs two recipes symmetrically', async () => {
      const a = await insertRecipe({ name: 'A' });
      const b = await insertRecipe({ name: 'B' });
      const caller = createCaller(makeContext());
      await caller.recipes.setBatchFields({ id: a, pairedRecipeId: b });
      expect(await readPair(a)).toBe(b);
      expect(await readPair(b)).toBe(a);
    });

    it('re-pairing A→C clears B and pairs C', async () => {
      const a = await insertRecipe({ name: 'A' });
      const b = await insertRecipe({ name: 'B' });
      const c = await insertRecipe({ name: 'C' });
      const caller = createCaller(makeContext());
      await caller.recipes.setBatchFields({ id: a, pairedRecipeId: b });
      await caller.recipes.setBatchFields({ id: a, pairedRecipeId: c });
      expect(await readPair(a)).toBe(c);
      expect(await readPair(b)).toBeNull();
      expect(await readPair(c)).toBe(a);
    });

    it("re-pairing A→C clears C's prior partner D", async () => {
      const a = await insertRecipe({ name: 'A' });
      const c = await insertRecipe({ name: 'C' });
      const d = await insertRecipe({ name: 'D' });
      const caller = createCaller(makeContext());
      await caller.recipes.setBatchFields({ id: c, pairedRecipeId: d });
      await caller.recipes.setBatchFields({ id: a, pairedRecipeId: c });
      expect(await readPair(a)).toBe(c);
      expect(await readPair(c)).toBe(a);
      expect(await readPair(d)).toBeNull();
    });

    it('clearing a pair clears both sides', async () => {
      const a = await insertRecipe({ name: 'A' });
      const b = await insertRecipe({ name: 'B' });
      const caller = createCaller(makeContext());
      await caller.recipes.setBatchFields({ id: a, pairedRecipeId: b });
      await caller.recipes.setBatchFields({ id: a, pairedRecipeId: null });
      expect(await readPair(a)).toBeNull();
      expect(await readPair(b)).toBeNull();
    });

    it('rejects pairing with self', async () => {
      const recipeId = await insertRecipe({ name: 'Solo' });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.setBatchFields({
          id: recipeId,
          pairedRecipeId: recipeId,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'RECIPE_BATCH_PAIR_SELF' },
      });
    });

    it('rejects pairing with a recipe from another household', async () => {
      const recipeId = await insertRecipe({ name: 'Mine' });
      const foreign = await insertRecipe({
        name: 'Foreign',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.setBatchFields({
          id: recipeId,
          pairedRecipeId: foreign,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'RECIPE_BATCH_PAIR_NOT_FOUND' },
      });
    });

    it('returns NOT_FOUND for a recipe in another household', async () => {
      const foreign = await insertRecipe({
        name: 'Foreign',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.setBatchFields({ id: foreign, isBase: true }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects an empty input at the boundary', async () => {
      const recipeId = await insertRecipe({ name: 'X' });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.setBatchFields({ id: recipeId }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects without a session', async () => {
      const recipeId = await insertRecipe({ name: 'X' });
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.recipes.setBatchFields({ id: recipeId, isBase: true }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('list with batch picker rules', () => {
    it('filters to bases only when isBase=true', async () => {
      await insertRecipe({ name: 'Beans Base', isBase: true });
      await insertRecipe({ name: 'Regular' });
      const caller = createCaller(makeContext());
      const result = await caller.recipes.list({ isBase: true });
      expect(result.items.map((r) => r.name)).toEqual(['Beans Base']);
    });

    it('hides batch-versions of soft-deleted bases when includePickerHidden', async () => {
      const liveBase = await insertRecipe({
        name: 'Live Base',
        isBase: true,
      });
      const deadBase = await insertRecipe({
        name: 'Dead Base',
        isBase: true,
        isDeleted: true,
      });
      await insertRecipe({ name: 'Child Of Live', baseRecipeId: liveBase });
      await insertRecipe({ name: 'Child Of Dead', baseRecipeId: deadBase });
      await insertRecipe({ name: 'Plain' });

      const caller = createCaller(makeContext());
      const visible = await caller.recipes.list({
        includePickerHidden: true,
      });
      const names = visible.items.map((r) => r.name);
      expect(names).toContain('Live Base');
      expect(names).toContain('Child Of Live');
      expect(names).toContain('Plain');
      expect(names).not.toContain('Dead Base');
      expect(names).not.toContain('Child Of Dead');
    });

    it('historical reads (no flag) still include batch-versions of deleted bases', async () => {
      const deadBase = await insertRecipe({
        name: 'Dead Base',
        isBase: true,
        isDeleted: true,
      });
      await insertRecipe({ name: 'Child Of Dead', baseRecipeId: deadBase });

      const caller = createCaller(makeContext());
      const includingDeleted = await caller.recipes.list({
        includeDeleted: true,
      });
      const names = includingDeleted.items.map((r) => r.name);
      expect(names).toContain('Dead Base');
      expect(names).toContain('Child Of Dead');
    });
  });

  describe('get with batch partners', () => {
    it('returns base + pair names and isDeleted flags', async () => {
      const base = await insertRecipe({ name: 'Bean Base', isBase: true });
      const partner = await insertRecipe({ name: 'Partner Recipe' });
      const child = await insertRecipe({
        name: 'Child Recipe',
        baseRecipeId: base,
        pairedRecipeId: partner,
      });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.get({ id: child });
      expect(result.baseRecipeName).toBe('Bean Base');
      expect(result.baseRecipeIsDeleted).toBe(false);
      expect(result.pairedRecipeName).toBe('Partner Recipe');
      expect(result.pairedRecipeIsDeleted).toBe(false);
    });

    it('returns null partner names when there is no link', async () => {
      const recipeId = await insertRecipe({ name: 'Lonely' });
      const caller = createCaller(makeContext());
      const result = await caller.recipes.get({ id: recipeId });
      expect(result.baseRecipeName).toBeNull();
      expect(result.baseRecipeIsDeleted).toBeNull();
      expect(result.pairedRecipeName).toBeNull();
      expect(result.pairedRecipeIsDeleted).toBeNull();
    });

    it('marks a soft-deleted pair partner as deleted', async () => {
      const partner = await insertRecipe({
        name: 'Gone Partner',
        isDeleted: true,
      });
      const recipeId = await insertRecipe({
        name: 'Self',
        pairedRecipeId: partner,
      });
      const caller = createCaller(makeContext());
      const result = await caller.recipes.get({ id: recipeId });
      expect(result.pairedRecipeName).toBe('Gone Partner');
      expect(result.pairedRecipeIsDeleted).toBe(true);
    });
  });

  describe('rate', () => {
    it('inserts a rating when none exists', async () => {
      const recipeId = await insertRecipe({ name: 'New rating' });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.rate({ recipeId, rating: 4 });

      expect(result).toEqual({ recipeId, rating: 4 });

      const detail = await caller.recipes.get({ id: recipeId });
      expect(detail.yourRating).toBe(4);
      expect(detail.averageRating).toBe(4);
      expect(detail.ratingCount).toBe(1);
    });

    it('upserts the existing row and advances lastUpdatedAt', async () => {
      const recipeId = await insertRecipe({ name: 'Reratable' });
      const caller = createCaller(makeContext());

      await caller.recipes.rate({ recipeId, rating: 2 });
      const firstRow = await db
        .select()
        .from(recipeRatings)
        .where(eq(recipeRatings.recipeId, recipeId));
      expect(firstRow).toHaveLength(1);
      const firstUpdatedAt = firstRow[0]?.lastUpdatedAt;
      if (!firstUpdatedAt) throw new Error('expected lastUpdatedAt');

      await new Promise((resolve) => setTimeout(resolve, 5));
      await caller.recipes.rate({ recipeId, rating: 5 });

      const secondRow = await db
        .select()
        .from(recipeRatings)
        .where(eq(recipeRatings.recipeId, recipeId));
      expect(secondRow).toHaveLength(1);
      expect(secondRow[0]?.rating).toBe(5);
      const secondUpdatedAt = secondRow[0]?.lastUpdatedAt;
      if (!secondUpdatedAt) throw new Error('expected lastUpdatedAt');
      expect(secondUpdatedAt.getTime()).toBeGreaterThan(
        firstUpdatedAt.getTime(),
      );
    });

    it('rejects rating values outside the 1-5 range', async () => {
      const recipeId = await insertRecipe({ name: 'Bounded' });
      const caller = createCaller(makeContext());

      await expect(
        caller.recipes.rate({ recipeId, rating: 0 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.recipes.rate({ recipeId, rating: 6 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects with NOT_FOUND for a recipe in another household', async () => {
      const recipeId = await insertRecipe({
        name: 'Foreign',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());

      await expect(
        caller.recipes.rate({ recipeId, rating: 3 }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects without a session', async () => {
      const recipeId = await insertRecipe({ name: 'Auth' });
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.recipes.rate({ recipeId, rating: 3 }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('unrate', () => {
    it("deletes the caller's row and reduces the aggregate", async () => {
      const recipeId = await insertRecipe({ name: 'Clearable' });
      await db.insert(recipeRatings).values([
        { recipeId, userId: USER_ID, rating: 5 },
        { recipeId, userId: OTHER_USER_ID, rating: 1 },
      ]);

      const caller = createCaller(makeContext());
      const result = await caller.recipes.unrate({ recipeId });
      expect(result).toEqual({ recipeId });

      const detail = await caller.recipes.get({ id: recipeId });
      expect(detail.yourRating).toBeNull();
      expect(detail.ratingCount).toBe(1);
      expect(detail.averageRating).toBe(1);
    });

    it('is idempotent when no rating exists', async () => {
      const recipeId = await insertRecipe({ name: 'Already gone' });
      const caller = createCaller(makeContext());
      await expect(caller.recipes.unrate({ recipeId })).resolves.toEqual({
        recipeId,
      });
      await expect(caller.recipes.unrate({ recipeId })).resolves.toEqual({
        recipeId,
      });
    });

    it("leaves another user's rating untouched", async () => {
      const recipeId = await insertRecipe({ name: 'Shared' });
      await db.insert(recipeRatings).values([
        { recipeId, userId: USER_ID, rating: 4 },
        { recipeId, userId: OTHER_USER_ID, rating: 2 },
      ]);

      const caller = createCaller(makeContext());
      await caller.recipes.unrate({ recipeId });

      const remaining = await db
        .select()
        .from(recipeRatings)
        .where(eq(recipeRatings.recipeId, recipeId));
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.userId).toBe(OTHER_USER_ID);
      expect(remaining[0]?.rating).toBe(2);
    });

    it('rejects with NOT_FOUND for a recipe in another household', async () => {
      const recipeId = await insertRecipe({
        name: 'Foreign',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(caller.recipes.unrate({ recipeId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('list rating aggregate', () => {
    it('returns null average and zero count for unrated recipes', async () => {
      await insertRecipe({ name: 'Unrated' });

      const caller = createCaller(makeContext());
      const result = await caller.recipes.list();
      const recipe = result.items[0];
      if (!recipe) throw new Error('expected one item');
      expect(recipe.averageRating).toBeNull();
      expect(recipe.ratingCount).toBe(0);
    });

    it('aggregates ratings across users on each list item', async () => {
      const ratedId = await insertRecipe({ name: 'Rated' });
      await insertRecipe({ name: 'Unrated' });
      await db.insert(recipeRatings).values([
        { recipeId: ratedId, userId: USER_ID, rating: 5 },
        { recipeId: ratedId, userId: OTHER_USER_ID, rating: 3 },
      ]);

      const caller = createCaller(makeContext());
      const result = await caller.recipes.list();
      const rated = result.items.find((r) => r.id === ratedId);
      const unrated = result.items.find((r) => r.id !== ratedId);
      expect(rated?.averageRating).toBe(4);
      expect(rated?.ratingCount).toBe(2);
      expect(unrated?.averageRating).toBeNull();
      expect(unrated?.ratingCount).toBe(0);
    });
  });

  describe('addComment', () => {
    it('inserts a comment authored by the caller and returns the row', async () => {
      const recipeId = await insertRecipe({ name: 'Commented' });
      const caller = createCaller(makeContext());

      const result = await caller.recipes.addComment({
        recipeId,
        comment: 'Use the dutch oven',
      });

      expect(result.recipeId).toBe(recipeId);
      expect(result.userId).toBe(USER_ID);
      expect(result.authorName).toBe('Tester');
      expect(result.comment).toBe('Use the dutch oven');
      expect(result.lastUpdatedAt).toBeNull();

      const stored = await db
        .select()
        .from(recipeComments)
        .where(eq(recipeComments.recipeId, recipeId));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.userId).toBe(USER_ID);
    });

    it('trims whitespace before storing', async () => {
      const recipeId = await insertRecipe({ name: 'Trimmed' });
      const caller = createCaller(makeContext());
      const result = await caller.recipes.addComment({
        recipeId,
        comment: '   double the garlic   ',
      });
      expect(result.comment).toBe('double the garlic');
    });

    it('rejects empty / whitespace-only text with BAD_REQUEST', async () => {
      const recipeId = await insertRecipe({ name: 'Empty' });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.addComment({ recipeId, comment: '' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.recipes.addComment({ recipeId, comment: '   ' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects text longer than 2000 chars', async () => {
      const recipeId = await insertRecipe({ name: 'Too long' });
      const caller = createCaller(makeContext());
      const overflow = 'a'.repeat(2001);
      await expect(
        caller.recipes.addComment({ recipeId, comment: overflow }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects with NOT_FOUND for a recipe in another household', async () => {
      const recipeId = await insertRecipe({
        name: 'Foreign',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.addComment({ recipeId, comment: 'hi' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects without a session', async () => {
      const recipeId = await insertRecipe({ name: 'Auth' });
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.recipes.addComment({ recipeId, comment: 'hi' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('editComment', () => {
    it('updates the text and sets lastUpdatedAt > createdAt', async () => {
      const recipeId = await insertRecipe({ name: 'Editable' });
      const caller = createCaller(makeContext());
      const created = await caller.recipes.addComment({
        recipeId,
        comment: 'first take',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const result = await caller.recipes.editComment({
        id: created.id,
        comment: 'second take',
      });
      expect(result.comment).toBe('second take');
      expect(result.lastUpdatedAt).not.toBeNull();
      if (!result.lastUpdatedAt) throw new Error('expected lastUpdatedAt');
      expect(new Date(result.lastUpdatedAt).getTime()).toBeGreaterThan(
        new Date(created.createdAt).getTime(),
      );
    });

    it('rejects FORBIDDEN when caller is not the author', async () => {
      const recipeId = await insertRecipe({ name: 'Theirs' });
      const authorCaller = createCaller(makeContext());
      const created = await authorCaller.recipes.addComment({
        recipeId,
        comment: 'mine',
      });
      const otherCaller = createCaller(makeContext({ userId: OTHER_USER_ID }));
      await expect(
        otherCaller.recipes.editComment({
          id: created.id,
          comment: 'hijacked',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects NOT_FOUND for a non-existent comment', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.editComment({ id: 9999, comment: 'lost' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects NOT_FOUND when comment is on a recipe in another household', async () => {
      const recipeId = await insertRecipe({
        name: 'Foreign',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const inserted = await db
        .insert(recipeComments)
        .values({ recipeId, userId: USER_ID, comment: 'theirs' })
        .returning({ id: recipeComments.id });
      const id = inserted[0]?.id;
      if (!id) throw new Error('insert failed');
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.editComment({ id, comment: 'no' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('validates: empty + max-length', async () => {
      const recipeId = await insertRecipe({ name: 'Validate' });
      const caller = createCaller(makeContext());
      const created = await caller.recipes.addComment({
        recipeId,
        comment: 'ok',
      });
      await expect(
        caller.recipes.editComment({ id: created.id, comment: '' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.recipes.editComment({
          id: created.id,
          comment: 'a'.repeat(2001),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('deleteComment', () => {
    it('hard-deletes the row when caller is the author', async () => {
      const recipeId = await insertRecipe({ name: 'Trash' });
      const caller = createCaller(makeContext());
      const created = await caller.recipes.addComment({
        recipeId,
        comment: 'gone',
      });
      const result = await caller.recipes.deleteComment({ id: created.id });
      expect(result).toEqual({ id: created.id });
      const remaining = await db
        .select()
        .from(recipeComments)
        .where(eq(recipeComments.id, created.id));
      expect(remaining).toHaveLength(0);
    });

    it('rejects FORBIDDEN for non-author', async () => {
      const recipeId = await insertRecipe({ name: 'Keep' });
      const authorCaller = createCaller(makeContext());
      const created = await authorCaller.recipes.addComment({
        recipeId,
        comment: 'mine',
      });
      const otherCaller = createCaller(makeContext({ userId: OTHER_USER_ID }));
      await expect(
        otherCaller.recipes.deleteComment({ id: created.id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects NOT_FOUND for a non-existent comment', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.deleteComment({ id: 9999 }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('listComments', () => {
    it('returns rows newest-first with author display name', async () => {
      const recipeId = await insertRecipe({ name: 'Threaded' });
      await db.insert(recipeComments).values([
        {
          recipeId,
          userId: USER_ID,
          comment: 'first',
          createdAt: new Date(Date.now() - 60_000),
        },
        {
          recipeId,
          userId: OTHER_USER_ID,
          comment: 'second',
          createdAt: new Date(Date.now() - 30_000),
        },
        {
          recipeId,
          userId: USER_ID,
          comment: 'third',
          createdAt: new Date(),
        },
      ]);

      const caller = createCaller(makeContext());
      const result = await caller.recipes.listComments({ recipeId });
      expect(result.items.map((r) => r.comment)).toEqual([
        'third',
        'second',
        'first',
      ]);
      expect(result.items[0]?.authorName).toBe('Recipe Tester');
      expect(result.items[1]?.authorName).toBe('Other Tester');
    });

    it('returns authorName: null for tombstoned authors', async () => {
      const recipeId = await insertRecipe({ name: 'Ghost' });
      await db.insert(recipeComments).values({
        recipeId,
        userId: null,
        comment: 'orphaned',
      });
      const caller = createCaller(makeContext());
      const result = await caller.recipes.listComments({ recipeId });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.userId).toBeNull();
      expect(result.items[0]?.authorName).toBeNull();
    });

    it('rejects NOT_FOUND for a recipe in another household', async () => {
      const recipeId = await insertRecipe({
        name: 'Foreign',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.recipes.listComments({ recipeId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns an empty list for a recipe with no comments', async () => {
      const recipeId = await insertRecipe({ name: 'Silent' });
      const caller = createCaller(makeContext());
      const result = await caller.recipes.listComments({ recipeId });
      expect(result.items).toEqual([]);
    });
  });
});
