import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { asc, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import { households } from '../src/db/schema/household.ts';
import { ingredients } from '../src/db/schema/ingredients.ts';
import {
  recipeIngredients,
  recipeMethod,
  recipeMethodIngredients,
  recipes,
} from '../src/db/schema/recipes.ts';
import {
  ingredientCategories,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

// The fill runs once, inside the migration that creates the table, so on a
// fresh database it sees no recipes. Re-run the same SQL block against
// seeded rows to exercise it.
const BACKFILL_SQL = readFileSync(
  path.join(MIGRATIONS_DIR, '0020_ordinary_liz_osborn.sql'),
  'utf8',
)
  .split('--> statement-breakpoint')
  .find((chunk) => chunk.includes('DO $$'));

describe('step ingredient backfill migration', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;
  let categoryId!: number;
  let unitId!: number;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.2-alpine').start();
    pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      max: 2,
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
        ${recipeMethodIngredients},
        ${recipeMethod},
        ${recipeIngredients},
        ${recipes},
        ${ingredients},
        ${ingredientCategories},
        ${unitsOfMeasurement},
        ${households}
      restart identity cascade
    `);
    await db
      .insert(households)
      .values({ id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" });
    const [category] = await db
      .insert(ingredientCategories)
      .values({ name: 'Pantry' })
      .returning();
    const [unit] = await db
      .insert(unitsOfMeasurement)
      .values({ name: 'g' })
      .returning();
    if (!category || !unit) throw new Error('reference seed failed');
    categoryId = category.id;
    unitId = unit.id;
  });

  async function seedRecipe(
    ingredientNames: readonly string[],
    steps: readonly string[],
  ): Promise<{ ingredientIds: Map<string, number>; stepIds: number[] }> {
    const ingredientRows = await db
      .insert(ingredients)
      .values(
        ingredientNames.map((name) => ({
          householdId: CURRENT_HOUSEHOLD_ID,
          name,
          categoryId,
          defaultUnitId: unitId,
        })),
      )
      .returning({ id: ingredients.id, name: ingredients.name });
    const [recipe] = await db
      .insert(recipes)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name: 'Backfill recipe',
        baseServings: 2,
      })
      .returning({ id: recipes.id });
    if (!recipe) throw new Error('recipe seed failed');
    await db.insert(recipeIngredients).values(
      ingredientRows.map((row) => ({
        recipeId: recipe.id,
        ingredientId: row.id,
        quantity: '100',
      })),
    );
    const stepRows = await db
      .insert(recipeMethod)
      .values(
        steps.map((instruction, index) => ({
          recipeId: recipe.id,
          stepNumber: index + 1,
          instruction,
        })),
      )
      .returning({ id: recipeMethod.id });
    return {
      ingredientIds: new Map(ingredientRows.map((row) => [row.name, row.id])),
      stepIds: stepRows.map((row) => row.id),
    };
  }

  async function runBackfill(): Promise<void> {
    if (!BACKFILL_SQL) throw new Error('backfill block not found');
    await db.execute(sql.raw(BACKFILL_SQL));
  }

  async function linksByStep(): Promise<Map<number, number[]>> {
    const rows = await db
      .select()
      .from(recipeMethodIngredients)
      .orderBy(
        asc(recipeMethodIngredients.methodStepId),
        asc(recipeMethodIngredients.ingredientId),
      );
    const byStep = new Map<number, number[]>();
    for (const row of rows) {
      expect(row.quantity).toBeNull();
      byStep.set(row.methodStepId, [
        ...(byStep.get(row.methodStepId) ?? []),
        row.ingredientId,
      ]);
    }
    return byStep;
  }

  it('links steps to the ingredients they name, case-insensitively and with plurals', async () => {
    const { ingredientIds, stepIds } = await seedRecipe(
      ['Onion', 'Tomato', 'Olive Oil'],
      ['Warm the OLIVE OIL and add the onions.', 'Add the tomatoes.', 'Stir.'],
    );
    await runBackfill();

    const links = await linksByStep();
    expect(links.get(stepIds[0] ?? 0)?.sort()).toEqual(
      [ingredientIds.get('Onion'), ingredientIds.get('Olive Oil')].sort(),
    );
    expect(links.get(stepIds[1] ?? 0)).toEqual([ingredientIds.get('Tomato')]);
    expect(links.has(stepIds[2] ?? 0)).toBe(false);
  });

  it('lets a longer name claim its text before a shorter one', async () => {
    const { ingredientIds, stepIds } = await seedRecipe(
      ['Pepper', 'Black Pepper'],
      [
        'Season with black pepper.',
        'Slice the pepper and season with black pepper.',
      ],
    );
    await runBackfill();

    const links = await linksByStep();
    expect(links.get(stepIds[0] ?? 0)).toEqual([
      ingredientIds.get('Black Pepper'),
    ]);
    expect(links.get(stepIds[1] ?? 0)?.sort()).toEqual(
      [ingredientIds.get('Pepper'), ingredientIds.get('Black Pepper')].sort(),
    );
  });

  it('falls back to the last word of a name only when no other ingredient uses it', async () => {
    const { ingredientIds, stepIds } = await seedRecipe(
      ['Sweet Potato', 'Tinned Tuna', 'Red Chilli', 'Green Chilli'],
      [
        'Roast the potatoes.',
        'Mix the drained tuna with the chilli.',
        'Serve.',
      ],
    );
    await runBackfill();

    const links = await linksByStep();
    expect(links.get(stepIds[0] ?? 0)).toEqual([
      ingredientIds.get('Sweet Potato'),
    ]);
    expect(links.get(stepIds[1] ?? 0)).toEqual([
      ingredientIds.get('Tinned Tuna'),
    ]);
    expect(links.has(stepIds[2] ?? 0)).toBe(false);
  });

  it('ignores bracketed parts of a name and survives regex characters in it', async () => {
    const { ingredientIds, stepIds } = await seedRecipe(
      ['Tomatoes (tinned)', 'Salt + Vinegar Crisps'],
      ['Pour in the tomatoes.', 'Top with salt + vinegar crisps.'],
    );
    await runBackfill();

    const links = await linksByStep();
    expect(links.get(stepIds[0] ?? 0)).toEqual([
      ingredientIds.get('Tomatoes (tinned)'),
    ]);
    expect(links.get(stepIds[1] ?? 0)).toEqual([
      ingredientIds.get('Salt + Vinegar Crisps'),
    ]);
  });

  it('does not match a name inside a longer word', async () => {
    const { stepIds } = await seedRecipe(['Pea'], ['Add the peanuts.']);
    await runBackfill();

    const links = await linksByStep();
    expect(links.has(stepIds[0] ?? 0)).toBe(false);
  });
});
