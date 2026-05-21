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
import { users } from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import { ingredients } from '../src/db/schema/ingredients.ts';
import { recipeDrafts } from '../src/db/schema/recipe-drafts.ts';
import {
  recipeComments,
  recipeRatings,
  relatedRecipes,
} from '../src/db/schema/recipe-social.ts';
import {
  recipeIngredients,
  recipeMethod,
  recipes,
} from '../src/db/schema/recipes.ts';
import {
  ingredientCategories,
  preparationTypes,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { runSeeds } from '../src/db/seeds/index.ts';
import { makeWithTransaction } from '../src/db/withTransaction.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const USER_ID = 'test-user-recipes-1';
const OTHER_USER_ID = 'test-user-recipes-2';

// Drizzle wraps pg errors in a `DrizzleQueryError` whose `.message` is the
// failed SQL, not the constraint name. The original `DatabaseError` from
// node-postgres is the `.cause`. This helper asserts on the constraint name
// directly so the tests prove which invariant fired.
async function expectConstraintViolation(
  promise: Promise<unknown>,
  expectedConstraint: string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const cause = (err as { cause?: { constraint?: string } }).cause;
    expect(cause?.constraint).toBe(expectedConstraint);
    return;
  }
  throw new Error(
    `expected query to throw with constraint '${expectedConstraint}', but it resolved`,
  );
}

async function seedFixtures(db: NodePgDatabase<Schema>): Promise<{
  categoryId: number;
  unitId: number;
  prepTypeId: number;
}> {
  const withTransaction = makeWithTransaction(db);
  await runSeeds(withTransaction);
  await db.insert(users).values([
    { id: USER_ID, name: 'A', email: 'a@example.com' },
    { id: OTHER_USER_ID, name: 'B', email: 'b@example.com' },
  ]);
  const [category] = await db
    .select({ id: ingredientCategories.id })
    .from(ingredientCategories)
    .limit(1);
  const [unit] = await db
    .select({ id: unitsOfMeasurement.id })
    .from(unitsOfMeasurement)
    .limit(1);
  const [prep] = await db
    .select({ id: preparationTypes.id })
    .from(preparationTypes)
    .limit(1);
  if (!category || !unit || !prep) {
    throw new Error('reference data seeded incompletely');
  }
  return { categoryId: category.id, unitId: unit.id, prepTypeId: prep.id };
}

async function insertIngredient(
  db: NodePgDatabase<Schema>,
  refs: { categoryId: number; unitId: number },
  name = 'Onion',
): Promise<number> {
  const [row] = await db
    .insert(ingredients)
    .values({
      householdId: CURRENT_HOUSEHOLD_ID,
      name,
      categoryId: refs.categoryId,
      defaultUnitId: refs.unitId,
    })
    .returning({ id: ingredients.id });
  if (!row) throw new Error('ingredient insert returned no row');
  return row.id;
}

async function insertRecipe(
  db: NodePgDatabase<Schema>,
  overrides: Partial<typeof recipes.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(recipes)
    .values({
      householdId: CURRENT_HOUSEHOLD_ID,
      name: 'Test recipe',
      baseServings: 4,
      ...overrides,
    })
    .returning({ id: recipes.id });
  if (!row) throw new Error('recipe insert returned no row');
  return row.id;
}

describe('recipes schema', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;

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
    // CASCADE clears the recipe-domain children alongside the parents.
    await db.execute(sql`
      truncate table
        ${users},
        ${households},
        ${ingredientCategories},
        ${unitsOfMeasurement},
        ${preparationTypes}
      restart identity cascade
    `);
  });

  describe('migration shape', () => {
    it('every recipe-domain table is present', async () => {
      const result = await db.execute<{ tablename: string }>(sql`
        select tablename from pg_tables where schemaname = 'public'
      `);
      const names = new Set(result.rows.map((r) => r.tablename));
      for (const expected of [
        'ingredients',
        'recipe_sources',
        'recipes',
        'recipe_ingredients',
        'recipe_method',
        'recipe_drafts',
        'related_recipes',
        'recipe_ratings',
        'recipe_comments',
      ]) {
        expect(names.has(expected), `missing table ${expected}`).toBe(true);
      }
    });

    it('recipes carries the eight per-serving macro columns', async () => {
      const expected = [
        'calories_per_serving',
        'carbs_per_serving',
        'fat_per_serving',
        'fibre_per_serving',
        'protein_per_serving',
        'salt_per_serving',
        'saturated_fat_per_serving',
        'sugar_per_serving',
      ];
      const result = await db.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'recipes'
      `);
      const present = new Set(result.rows.map((r) => r.column_name));
      for (const macro of expected) {
        expect(present.has(macro), `missing macro column ${macro}`).toBe(true);
      }
    });

    it('pg_trgm extension is installed', async () => {
      const result = await db.execute<{ extname: string }>(sql`
        select extname from pg_extension where extname = 'pg_trgm'
      `);
      expect(result.rows).toHaveLength(1);
    });

    it('GIN trigram index on lower(name) exists on ingredients', async () => {
      const result = await db.execute<{ indexdef: string }>(sql`
        select indexdef from pg_indexes
        where schemaname = 'public'
          and tablename = 'ingredients'
          and indexname = 'ingredients_name_trgm_idx'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.indexdef).toMatch(/USING gin/i);
      expect(result.rows[0]?.indexdef).toContain('lower(name)');
      expect(result.rows[0]?.indexdef).toContain('gin_trgm_ops');
    });

    it('GIN trigram index on lower(name) exists on recipes', async () => {
      const result = await db.execute<{ indexdef: string }>(sql`
        select indexdef from pg_indexes
        where schemaname = 'public'
          and tablename = 'recipes'
          and indexname = 'recipes_name_trgm_idx'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.indexdef).toMatch(/USING gin/i);
      expect(result.rows[0]?.indexdef).toContain('lower(name)');
      expect(result.rows[0]?.indexdef).toContain('gin_trgm_ops');
    });

    it('recipe_ingredients has no unique constraint on (recipe_id, ingredient_id)', async () => {
      // Look for any unique index covering exactly those two columns.
      const result = await db.execute<{
        indexname: string;
        indexdef: string;
      }>(sql`
        select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'recipe_ingredients'
      `);
      const offender = result.rows.find(
        (r) =>
          /UNIQUE/i.test(r.indexdef) &&
          r.indexdef.includes('(recipe_id, ingredient_id)'),
      );
      expect(
        offender,
        'unexpected unique index over (recipe_id, ingredient_id)',
      ).toBeUndefined();
    });
  });

  describe('recipes CHECK constraints', () => {
    it('accepts a base recipe with base_recipe_id NULL', async () => {
      await seedFixtures(db);
      await expect(
        insertRecipe(db, { name: 'Lamb keema base', isBase: true }),
      ).resolves.toBeGreaterThan(0);
    });

    it('accepts a batch recipe referencing a real base', async () => {
      await seedFixtures(db);
      const baseId = await insertRecipe(db, {
        name: 'Lamb keema base',
        isBase: true,
      });
      await expect(
        insertRecipe(db, {
          name: 'Keema with flatbread (batch)',
          isBase: false,
          baseRecipeId: baseId,
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('rejects a recipe with is_base = true AND base_recipe_id NOT NULL', async () => {
      await seedFixtures(db);
      const baseId = await insertRecipe(db, {
        name: 'Lamb keema base',
        isBase: true,
      });
      await expectConstraintViolation(
        insertRecipe(db, {
          name: 'Confused recipe',
          isBase: true,
          baseRecipeId: baseId,
        }),
        'recipes_base_xor_batch',
      );
    });

    it('rejects a self-referencing base_recipe_id', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      await expectConstraintViolation(
        db.execute(sql`
          update recipes set base_recipe_id = ${recipeId} where id = ${recipeId}
        `),
        'recipes_base_not_self',
      );
    });

    it('rejects a self-referencing paired_recipe_id', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      await expectConstraintViolation(
        db.execute(sql`
          update recipes set paired_recipe_id = ${recipeId} where id = ${recipeId}
        `),
        'recipes_paired_not_self',
      );
    });
  });

  describe('recipe_ingredients shape', () => {
    it('allows duplicate (recipe_id, ingredient_id) rows with different prep types', async () => {
      const refs = await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      const ingredientId = await insertIngredient(db, refs);
      // Seed a second prep type so we can differentiate the rows.
      const [secondPrep] = await db
        .insert(preparationTypes)
        .values({ name: 'sliced-test' })
        .returning({ id: preparationTypes.id });
      if (!secondPrep) throw new Error('failed to insert second prep type');
      await db.insert(recipeIngredients).values([
        {
          recipeId,
          ingredientId,
          quantity: '1.000',
          prepTypeId: refs.prepTypeId,
        },
        {
          recipeId,
          ingredientId,
          quantity: '2.000',
          prepTypeId: secondPrep.id,
        },
      ]);
      const rows = await db
        .select()
        .from(recipeIngredients)
        .where(eq(recipeIngredients.recipeId, recipeId));
      expect(rows).toHaveLength(2);
    });
  });

  describe('recipe_method', () => {
    it('rejects a duplicate step_number for the same recipe', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      await db
        .insert(recipeMethod)
        .values({ recipeId, stepNumber: 1, instruction: 'Heat oil' });
      await expectConstraintViolation(
        db
          .insert(recipeMethod)
          .values({ recipeId, stepNumber: 1, instruction: 'And again' }),
        'recipe_method_recipe_step_unique',
      );
    });
  });

  describe('related_recipes', () => {
    it('rejects a pair with recipe_one_id >= recipe_two_id', async () => {
      await seedFixtures(db);
      const a = await insertRecipe(db, { name: 'A' });
      const b = await insertRecipe(db, { name: 'B' });
      const [lo, hi] = a < b ? [a, b] : [b, a];
      await expectConstraintViolation(
        db.insert(relatedRecipes).values({ recipeOneId: hi, recipeTwoId: lo }),
        'related_recipes_one_lt_two',
      );
    });

    it('rejects a duplicate pair (composite PK)', async () => {
      await seedFixtures(db);
      const a = await insertRecipe(db, { name: 'A' });
      const b = await insertRecipe(db, { name: 'B' });
      const [lo, hi] = a < b ? [a, b] : [b, a];
      await db
        .insert(relatedRecipes)
        .values({ recipeOneId: lo, recipeTwoId: hi });
      await expect(
        db.insert(relatedRecipes).values({ recipeOneId: lo, recipeTwoId: hi }),
      ).rejects.toThrow();
    });
  });

  describe('recipe_ratings', () => {
    it('rejects rating = 0', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      await expectConstraintViolation(
        db
          .insert(recipeRatings)
          .values({ recipeId, userId: USER_ID, rating: 0 }),
        'recipe_ratings_rating_range',
      );
    });

    it('rejects rating = 6', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      await expectConstraintViolation(
        db
          .insert(recipeRatings)
          .values({ recipeId, userId: USER_ID, rating: 6 }),
        'recipe_ratings_rating_range',
      );
    });

    it('accepts ratings 1..5', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      for (const rating of [1, 2, 3, 4, 5] as const) {
        // Use distinct recipes per insert so the (recipe_id, user_id) UNIQUE
        // doesn't fire.
        const target =
          rating === 1
            ? recipeId
            : await insertRecipe(db, { name: `R${String(rating)}` });
        await db
          .insert(recipeRatings)
          .values({ recipeId: target, userId: USER_ID, rating });
      }
    });

    it('rejects a second rating from the same user on the same recipe', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      await db
        .insert(recipeRatings)
        .values({ recipeId, userId: USER_ID, rating: 5 });
      await expectConstraintViolation(
        db
          .insert(recipeRatings)
          .values({ recipeId, userId: USER_ID, rating: 3 }),
        'recipe_ratings_recipe_user_unique',
      );
    });
  });

  describe('recipe_drafts', () => {
    it('rejects the same (user_id, recipe_id) pair twice', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      await db.insert(recipeDrafts).values({
        userId: USER_ID,
        recipeId,
        draftData: { name: 'edit-1' },
      });
      await expectConstraintViolation(
        db.insert(recipeDrafts).values({
          userId: USER_ID,
          recipeId,
          draftData: { name: 'edit-2' },
        }),
        'recipe_drafts_user_recipe_unique',
      );
    });

    it('allows multiple new-recipe drafts (recipe_id NULL) for the same user', async () => {
      await seedFixtures(db);
      await db.insert(recipeDrafts).values({
        userId: USER_ID,
        draftData: { name: 'new-1' },
      });
      await db.insert(recipeDrafts).values({
        userId: USER_ID,
        draftData: { name: 'new-2' },
      });
      const rows = await db
        .select()
        .from(recipeDrafts)
        .where(eq(recipeDrafts.userId, USER_ID));
      expect(rows).toHaveLength(2);
    });
  });

  describe('FK ON DELETE behaviour', () => {
    it('sets recipes.added_by_user_id to NULL when the user is deleted', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db, { addedByUserId: USER_ID });
      await db.delete(users).where(eq(users.id, USER_ID));
      const [row] = await db
        .select({ addedByUserId: recipes.addedByUserId })
        .from(recipes)
        .where(eq(recipes.id, recipeId));
      expect(row?.addedByUserId).toBeNull();
    });

    it('sets recipe_comments.user_id to NULL when the user is deleted', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      const [comment] = await db
        .insert(recipeComments)
        .values({ recipeId, userId: USER_ID, comment: 'nice' })
        .returning({ id: recipeComments.id });
      if (!comment) throw new Error('failed to insert comment');
      await db.delete(users).where(eq(users.id, USER_ID));
      const [row] = await db
        .select({ userId: recipeComments.userId })
        .from(recipeComments)
        .where(eq(recipeComments.id, comment.id));
      expect(row?.userId).toBeNull();
    });

    it('rejects deleting a user with an existing rating (RESTRICT)', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      await db
        .insert(recipeRatings)
        .values({ recipeId, userId: USER_ID, rating: 5 });
      await expect(
        db.delete(users).where(eq(users.id, USER_ID)),
      ).rejects.toThrow();
    });

    it('rejects deleting a user with an existing draft (RESTRICT)', async () => {
      await seedFixtures(db);
      await db.insert(recipeDrafts).values({
        userId: USER_ID,
        draftData: { name: 'wip' },
      });
      await expect(
        db.delete(users).where(eq(users.id, USER_ID)),
      ).rejects.toThrow();
    });

    it('rejects deleting an ingredient referenced by recipe_ingredients (RESTRICT)', async () => {
      const refs = await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      const ingredientId = await insertIngredient(db, refs);
      await db.insert(recipeIngredients).values({
        recipeId,
        ingredientId,
        quantity: '1.000',
      });
      await expect(
        db.delete(ingredients).where(eq(ingredients.id, ingredientId)),
      ).rejects.toThrow();
    });

    it('rejects deleting a base recipe referenced by base_recipe_id (RESTRICT)', async () => {
      await seedFixtures(db);
      const baseId = await insertRecipe(db, {
        name: 'Lamb keema base',
        isBase: true,
      });
      await insertRecipe(db, {
        name: 'Keema (batch)',
        baseRecipeId: baseId,
      });
      await expect(
        db.delete(recipes).where(eq(recipes.id, baseId)),
      ).rejects.toThrow();
    });

    it('nulls paired_recipe_id when the referenced recipe is deleted', async () => {
      await seedFixtures(db);
      const a = await insertRecipe(db, { name: 'A' });
      const b = await insertRecipe(db, { name: 'B' });
      // Recipe B points to A; deleting A should null B's pair.
      await db
        .update(recipes)
        .set({ pairedRecipeId: a })
        .where(eq(recipes.id, b));
      await db.delete(recipes).where(eq(recipes.id, a));
      const [row] = await db
        .select({ pairedRecipeId: recipes.pairedRecipeId })
        .from(recipes)
        .where(eq(recipes.id, b));
      expect(row?.pairedRecipeId).toBeNull();
    });
  });

  describe('$onUpdate timestamps', () => {
    it('bumps recipes.date_last_updated on update', async () => {
      await seedFixtures(db);
      const past = new Date('2020-01-01');
      const [row] = await db
        .insert(recipes)
        .values({
          householdId: CURRENT_HOUSEHOLD_ID,
          name: 'Original',
          baseServings: 4,
          dateLastUpdated: past,
        })
        .returning({ id: recipes.id });
      if (!row) throw new Error('insert returned no row');
      await db
        .update(recipes)
        .set({ name: 'Renamed' })
        .where(eq(recipes.id, row.id));
      const [after] = await db
        .select({ dateLastUpdated: recipes.dateLastUpdated })
        .from(recipes)
        .where(eq(recipes.id, row.id));
      expect(after?.dateLastUpdated).toBeInstanceOf(Date);
      expect(after?.dateLastUpdated.getTime()).toBeGreaterThan(past.getTime());
    });

    it('bumps recipe_ratings.last_updated_at on update', async () => {
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      const past = new Date('2020-01-01T00:00:00Z');
      const [rating] = await db
        .insert(recipeRatings)
        .values({
          recipeId,
          userId: USER_ID,
          rating: 3,
          lastUpdatedAt: past,
        })
        .returning({ id: recipeRatings.id });
      if (!rating) throw new Error('insert returned no row');
      await db
        .update(recipeRatings)
        .set({ rating: 5 })
        .where(eq(recipeRatings.id, rating.id));
      const [after] = await db
        .select({ lastUpdatedAt: recipeRatings.lastUpdatedAt })
        .from(recipeRatings)
        .where(eq(recipeRatings.id, rating.id));
      expect(after?.lastUpdatedAt.getTime()).toBeGreaterThan(past.getTime());
    });

    it('recipe_comments.last_updated_at stays NULL on insert and persists when set explicitly', async () => {
      // Spec: `last_updated_at timestamptz NULL` (plan.md line 229). The
      // column has no $onUpdate so app code (FEAT-29) sets it on edit.
      // NULL → "never edited"; non-NULL → "(edited)".
      await seedFixtures(db);
      const recipeId = await insertRecipe(db);
      const [comment] = await db
        .insert(recipeComments)
        .values({ recipeId, userId: USER_ID, comment: 'first' })
        .returning({
          id: recipeComments.id,
          lastUpdatedAt: recipeComments.lastUpdatedAt,
        });
      if (!comment) throw new Error('insert returned no row');
      expect(comment.lastUpdatedAt).toBeNull();

      const editedAt = new Date('2026-03-01T12:00:00Z');
      await db
        .update(recipeComments)
        .set({ comment: 'edited', lastUpdatedAt: editedAt })
        .where(eq(recipeComments.id, comment.id));
      const [after] = await db
        .select({ lastUpdatedAt: recipeComments.lastUpdatedAt })
        .from(recipeComments)
        .where(eq(recipeComments.id, comment.id));
      expect(after?.lastUpdatedAt).toEqual(editedAt);
    });

    it('bumps recipe_drafts.last_updated_at on update', async () => {
      await seedFixtures(db);
      const past = new Date('2020-01-01T00:00:00Z');
      const [draft] = await db
        .insert(recipeDrafts)
        .values({
          userId: USER_ID,
          draftData: { name: 'v1' },
          lastUpdatedAt: past,
        })
        .returning({ id: recipeDrafts.id });
      if (!draft) throw new Error('insert returned no row');
      await db
        .update(recipeDrafts)
        .set({ draftData: { name: 'v2' } })
        .where(eq(recipeDrafts.id, draft.id));
      const [after] = await db
        .select({ lastUpdatedAt: recipeDrafts.lastUpdatedAt })
        .from(recipeDrafts)
        .where(eq(recipeDrafts.id, draft.id));
      expect(after?.lastUpdatedAt.getTime()).toBeGreaterThan(past.getTime());
    });
  });
});
