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
import { ingredients } from '../src/db/schema/ingredients.ts';
import {
  ingredientCategories,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { recipeIngredients, recipes } from '../src/db/schema/recipes.ts';
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
const SESSION_ID = 'session-test-1';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-000000000999';

describe('ingredients procedures', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;
  let categoryId!: number;
  let otherCategoryId!: number;
  let unitId!: number;
  let otherUnitId!: number;

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
        ${recipeIngredients},
        ${recipes},
        ${ingredients},
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
    await db.insert(users).values({
      id: USER_ID,
      email: USER_EMAIL,
      name: 'Test User',
      emailVerified: true,
    });
    const cats = await db
      .insert(ingredientCategories)
      .values([{ name: 'Fruit & Veg' }, { name: 'Pantry' }])
      .returning();
    const [cat0, cat1] = cats;
    if (!cat0 || !cat1) throw new Error('category seed failed');
    categoryId = cat0.id;
    otherCategoryId = cat1.id;
    const units = await db
      .insert(unitsOfMeasurement)
      .values([{ name: 'g' }, { name: 'piece' }])
      .returning();
    const [unit0, unit1] = units;
    if (!unit0 || !unit1) throw new Error('unit seed failed');
    unitId = unit0.id;
    otherUnitId = unit1.id;
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

  async function insertIngredient(overrides: {
    name: string;
    householdId?: string;
    isPlant?: boolean;
    averageShelfLifeDays?: number | null;
    categoryId?: number;
    defaultUnitId?: number;
  }): Promise<number> {
    const inserted = await db
      .insert(ingredients)
      .values({
        householdId: overrides.householdId ?? CURRENT_HOUSEHOLD_ID,
        name: overrides.name,
        categoryId: overrides.categoryId ?? categoryId,
        defaultUnitId: overrides.defaultUnitId ?? unitId,
        isPlant: overrides.isPlant ?? false,
        averageShelfLifeDays: overrides.averageShelfLifeDays ?? null,
      })
      .returning({ id: ingredients.id });
    const row = inserted[0];
    if (!row) throw new Error('ingredient insert failed');
    return row.id;
  }

  async function insertRecipeWithIngredient(
    ingredientId: number,
    options: { isDeleted?: boolean } = {},
  ): Promise<number> {
    const insertedRecipe = await db
      .insert(recipes)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name: 'Test Recipe',
        baseServings: 2,
        isDeleted: options.isDeleted ?? false,
      })
      .returning({ id: recipes.id });
    const recipeRow = insertedRecipe[0];
    if (!recipeRow) throw new Error('recipe insert failed');
    const recipeId = recipeRow.id;
    await db.insert(recipeIngredients).values({
      recipeId,
      ingredientId,
      quantity: '100',
    });
    return recipeId;
  }

  describe('list', () => {
    it('returns rows scoped to the current household, joined with names', async () => {
      await insertIngredient({ name: 'Banana', isPlant: true });
      await insertIngredient({ name: 'Apple', isPlant: true });
      await insertIngredient({
        name: 'Hidden',
        householdId: OTHER_HOUSEHOLD_ID,
      });

      const caller = createCaller(makeContext());
      const list = await caller.ingredients.list();

      expect(list.map((i) => i.name)).toEqual(['Apple', 'Banana']);
      expect(list[0]).toMatchObject({
        name: 'Apple',
        categoryName: 'Fruit & Veg',
        defaultUnitName: 'g',
        isPlant: true,
      });
    });

    it('filters by case-insensitive substring search', async () => {
      await insertIngredient({ name: 'Onion' });
      await insertIngredient({ name: 'Spring onion' });
      await insertIngredient({ name: 'Carrot' });

      const caller = createCaller(makeContext());
      const list = await caller.ingredients.list({ search: 'ONI' });

      expect(list.map((i) => i.name).sort()).toEqual(['Onion', 'Spring onion']);
    });

    it('returns empty array when search matches nothing', async () => {
      await insertIngredient({ name: 'Onion' });
      const caller = createCaller(makeContext());
      const list = await caller.ingredients.list({ search: 'zzz' });
      expect(list).toEqual([]);
    });

    it('rejects without a session', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(caller.ingredients.list()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('create', () => {
    it('inserts a row scoped to CURRENT_HOUSEHOLD_ID and returns the denormalised row', async () => {
      const caller = createCaller(makeContext());
      const created = await caller.ingredients.create({
        name: 'Onion',
        categoryId,
        defaultUnitId: unitId,
        isPlant: true,
        averageShelfLifeDays: 30,
      });

      expect(created).toMatchObject({
        name: 'Onion',
        categoryName: 'Fruit & Veg',
        defaultUnitName: 'g',
        isPlant: true,
        averageShelfLifeDays: 30,
      });

      const row = await db
        .select()
        .from(ingredients)
        .where(eq(ingredients.id, created.id));
      expect(row[0]?.householdId).toBe(CURRENT_HOUSEHOLD_ID);
    });

    it('rejects empty name', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.ingredients.create({
          name: '   ',
          categoryId,
          defaultUnitId: unitId,
          isPlant: false,
          averageShelfLifeDays: null,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects non-positive shelf life', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.ingredients.create({
          name: 'Onion',
          categoryId,
          defaultUnitId: unitId,
          isPlant: false,
          averageShelfLifeDays: 0,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('returns CONFLICT + INGREDIENT_NAME_TAKEN on case-insensitive duplicate', async () => {
      const caller = createCaller(makeContext());
      await caller.ingredients.create({
        name: 'Onion',
        categoryId,
        defaultUnitId: unitId,
        isPlant: false,
        averageShelfLifeDays: null,
      });

      await expect(
        caller.ingredients.create({
          name: 'onion',
          categoryId,
          defaultUnitId: unitId,
          isPlant: false,
          averageShelfLifeDays: null,
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'INGREDIENT_NAME_TAKEN' },
      });
    });

    it('allows the same name in a different household', async () => {
      await insertIngredient({
        name: 'Onion',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      const created = await caller.ingredients.create({
        name: 'Onion',
        categoryId,
        defaultUnitId: unitId,
        isPlant: false,
        averageShelfLifeDays: null,
      });
      expect(created.name).toBe('Onion');
    });

    it('rejects without a session', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.ingredients.create({
          name: 'Onion',
          categoryId,
          defaultUnitId: unitId,
          isPlant: false,
          averageShelfLifeDays: null,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('update', () => {
    it('mutates the targeted row', async () => {
      const id = await insertIngredient({ name: 'Onion' });
      const caller = createCaller(makeContext());
      const updated = await caller.ingredients.update({
        id,
        patch: {
          name: 'Red onion',
          categoryId: otherCategoryId,
          defaultUnitId: otherUnitId,
          isPlant: true,
          averageShelfLifeDays: 14,
        },
      });

      expect(updated).toMatchObject({
        name: 'Red onion',
        categoryName: 'Pantry',
        defaultUnitName: 'piece',
        isPlant: true,
        averageShelfLifeDays: 14,
      });
    });

    it('returns NOT_FOUND for unknown id', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.ingredients.update({
          id: 999_999,
          patch: { name: 'X' },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('treats an id from another household as NOT_FOUND', async () => {
      const id = await insertIngredient({
        name: 'Hidden',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.ingredients.update({ id, patch: { name: 'Renamed' } }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns CONFLICT + INGREDIENT_NAME_TAKEN on rename collision', async () => {
      await insertIngredient({ name: 'Onion' });
      const id = await insertIngredient({ name: 'Carrot' });
      const caller = createCaller(makeContext());
      await expect(
        caller.ingredients.update({
          id,
          patch: { name: 'ONION' },
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'INGREDIENT_NAME_TAKEN' },
      });
    });

    it('allows renaming an ingredient to its existing name', async () => {
      const id = await insertIngredient({ name: 'Onion' });
      const caller = createCaller(makeContext());
      const updated = await caller.ingredients.update({
        id,
        patch: { name: 'Onion' },
      });
      expect(updated.name).toBe('Onion');
    });

    it('rejects an empty patch', async () => {
      const id = await insertIngredient({ name: 'Onion' });
      const caller = createCaller(makeContext());
      await expect(
        caller.ingredients.update({ id, patch: {} }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects without a session', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.ingredients.update({ id: 1, patch: { name: 'X' } }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('delete', () => {
    it('hard-deletes when no recipe references it', async () => {
      const id = await insertIngredient({ name: 'Onion' });
      const caller = createCaller(makeContext());
      await caller.ingredients.delete({ id });

      const remaining = await db
        .select()
        .from(ingredients)
        .where(eq(ingredients.id, id));
      expect(remaining).toEqual([]);
    });

    it('raises CONFLICT + INGREDIENT_IN_USE when an active recipe references it', async () => {
      const id = await insertIngredient({ name: 'Onion' });
      await insertRecipeWithIngredient(id);
      const caller = createCaller(makeContext());
      await expect(caller.ingredients.delete({ id })).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'INGREDIENT_IN_USE' },
      });
    });

    it('raises CONFLICT + INGREDIENT_IN_USE when only a soft-deleted recipe references it', async () => {
      const id = await insertIngredient({ name: 'Onion' });
      await insertRecipeWithIngredient(id, { isDeleted: true });
      const caller = createCaller(makeContext());
      await expect(caller.ingredients.delete({ id })).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'INGREDIENT_IN_USE' },
      });
    });

    it('returns NOT_FOUND for unknown id', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.ingredients.delete({ id: 999_999 }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('treats an id from another household as NOT_FOUND', async () => {
      const id = await insertIngredient({
        name: 'Hidden',
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(caller.ingredients.delete({ id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('rejects without a session', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(caller.ingredients.delete({ id: 1 })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
