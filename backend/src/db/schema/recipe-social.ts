import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { users } from './auth.ts';
import { recipes } from './recipes.ts';

// Manually-linked symmetric pairs. The composite PK + CHECK(one < two)
// enforces symmetry at the DB level — there's only ever one row per pair
// (`docs/plan.md` line 225). Soft-deleted recipes stay in the table so past
// plans render; the UI hides them.
export const relatedRecipes = pgTable(
  'related_recipes',
  {
    recipeOneId: integer()
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    recipeTwoId: integer()
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.recipeOneId, table.recipeTwoId] }),
    check(
      'related_recipes_one_lt_two',
      sql`${table.recipeOneId} < ${table.recipeTwoId}`,
    ),
    index('related_recipes_two_id_idx').on(table.recipeTwoId),
  ],
);

// One rating per (recipe, user). `user_id` is RESTRICT — account-deletion
// (FEAT-35) deletes the user's ratings as step 1 of the tombstoning sequence
// (DEC-29, `docs/plan.md` lines 86–91), so the RESTRICT forces that step.
export const recipeRatings = pgTable(
  'recipe_ratings',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    recipeId: integer()
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    rating: smallint().notNull(),
    lastUpdatedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex('recipe_ratings_recipe_user_unique').on(
      table.recipeId,
      table.userId,
    ),
    check('recipe_ratings_rating_range', sql`${table.rating} BETWEEN 1 AND 5`),
  ],
);

// Comments survive their author: `user_id` is SET NULL so the row remains
// for historical context and the UI renders it as "[deleted user]" (DEC-29).
// `last_updated_at` is nullable: INSERT leaves it NULL, comment edits set it
// explicitly in the application layer (FEAT-29). NULL means "never edited",
// which is what the UI's "(edited)" affordance keys off. Deliberately no
// `$onUpdate` — that would fire on INSERT too and the column would never be
// NULL, defeating the inference.
export const recipeComments = pgTable(
  'recipe_comments',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    recipeId: integer()
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    userId: text().references(() => users.id, { onDelete: 'set null' }),
    comment: text().notNull(),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastUpdatedAt: timestamp({ withTimezone: true }),
  },
  (table) => [index('recipe_comments_recipe_id_idx').on(table.recipeId)],
);
