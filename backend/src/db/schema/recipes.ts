import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.ts';
import { households } from './household.ts';
import { ingredients } from './ingredients.ts';
import { preparationTypes } from './reference.ts';

// User-extensible source list — household-scoped (DEC-17). Two households
// can both have a "Mob Kitchen" row; the unique constraint scopes to the
// household.
export const recipeSources = pgTable(
  'recipe_sources',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'restrict' }),
    name: text().notNull(),
  },
  (table) => [
    uniqueIndex('recipe_sources_household_name_unique').on(
      table.householdId,
      table.name,
    ),
  ],
);

// Recipes — household-scoped, soft-deleted (DEC-21), with two-level batch
// model (DEC-23): a recipe is either a base (`is_base = true`) OR a
// batch-version pointing at one base (`base_recipe_id`), enforced by the
// XOR CHECK. `paired_recipe_id` links full↔batch siblings; symmetry is
// maintained by the application (FEAT-23), not the DB. Eight per-serving
// macros (deviates from `docs/plan.md` line 217's "six" — see session-notes
// 2026-05-21).
//
// Self-referential FKs use the documented `(): AnyPgColumn => recipes.id`
// pattern; the lazy arrow lets Drizzle resolve the back-reference at table
// finalisation.
export const recipes = pgTable(
  'recipes',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    description: text(),
    imageUrl: text(),
    baseServings: smallint().notNull(),
    activeTimeMins: smallint(),
    totalTimeMins: smallint(),
    estimatedCostPerServing: numeric({ precision: 10, scale: 2 }),
    sourceId: integer().references(() => recipeSources.id, {
      onDelete: 'restrict',
    }),
    sourceUrl: text(),
    sourceDetail: text(),
    caloriesPerServing: smallint(),
    proteinPerServing: smallint(),
    carbsPerServing: smallint(),
    fatPerServing: smallint(),
    saturatedFatPerServing: smallint(),
    fibrePerServing: smallint(),
    sugarPerServing: smallint(),
    saltPerServing: smallint(),
    addedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    // `mode: 'date'` so `$onUpdate(() => new Date())` is type-correct; Drizzle
    // serializes the JS Date back to a SQL `date` literal.
    dateAdded: date({ mode: 'date' })
      .notNull()
      .default(sql`current_date`),
    dateLastUpdated: date({ mode: 'date' })
      .notNull()
      .default(sql`current_date`)
      .$onUpdate(() => new Date()),
    isDeleted: boolean().notNull().default(false),
    isBase: boolean().notNull().default(false),
    baseRecipeId: integer().references((): AnyPgColumn => recipes.id, {
      onDelete: 'restrict',
    }),
    pairedRecipeId: integer().references((): AnyPgColumn => recipes.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    check(
      'recipes_base_not_self',
      sql`${table.baseRecipeId} IS NULL OR ${table.baseRecipeId} != ${table.id}`,
    ),
    // A recipe is either a base or a batch-version, never both. Allowed:
    // (is_base=true, base_recipe_id=NULL), (is_base=false, base_recipe_id=NULL),
    // (is_base=false, base_recipe_id=<id>). Rejected: (is_base=true, base_recipe_id=<id>).
    check(
      'recipes_base_xor_batch',
      sql`NOT (${table.isBase} AND ${table.baseRecipeId} IS NOT NULL)`,
    ),
    check(
      'recipes_paired_not_self',
      sql`${table.pairedRecipeId} IS NULL OR ${table.pairedRecipeId} != ${table.id}`,
    ),
    index('recipes_household_id_idx').on(table.householdId),
    index('recipes_name_trgm_idx').using(
      'gin',
      sql`lower(${table.name}) gin_trgm_ops`,
    ),
  ],
);

// Surrogate PK + no uniqueness on (recipe_id, ingredient_id) — duplicates
// with different prep types are intentional ("1 onion sliced" + "1 onion
// diced"; `docs/plan.md` line 219).
export const recipeIngredients = pgTable(
  'recipe_ingredients',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    recipeId: integer()
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    ingredientId: integer()
      .notNull()
      .references(() => ingredients.id, { onDelete: 'restrict' }),
    quantity: numeric({ precision: 10, scale: 3 }).notNull(),
    prepTypeId: smallint().references(() => preparationTypes.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => [
    index('recipe_ingredients_recipe_id_idx').on(table.recipeId),
    index('recipe_ingredients_ingredient_id_idx').on(table.ingredientId),
  ],
);

export const recipeMethod = pgTable(
  'recipe_method',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    recipeId: integer()
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    stepNumber: smallint().notNull(),
    instruction: text().notNull(),
  },
  (table) => [
    uniqueIndex('recipe_method_recipe_step_unique').on(
      table.recipeId,
      table.stepNumber,
    ),
  ],
);
