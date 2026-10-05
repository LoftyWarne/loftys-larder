import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { recipes } from './recipes.ts';

// An Original is an image the recipe was imported from, or its one PDF, at
// position 0 (DEC-111).
export const recipeImportOriginalFormat = pgEnum(
  'recipe_import_original_format',
  ['image', 'pdf'],
);

// What a recipe was imported from, kept for "View original" (DEC-107).
// Household data like the recipe: scoped through the join to `recipes`
// (DEC-17), kept through soft delete (DEC-21) and account deletion (DEC-29).
// Rows never change, so there's no `updated_at`.
export const recipeImportOriginals = pgTable(
  'recipe_import_originals',
  {
    recipeId: integer()
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    position: smallint().notNull(),
    publicId: text().notNull(),
    format: recipeImportOriginalFormat().notNull().default('image'),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    primaryKey({ columns: [table.recipeId, table.position] }),
    uniqueIndex('recipe_import_originals_public_id_unique').on(table.publicId),
    check(
      'recipe_import_originals_position_nonnegative',
      sql`${table.position} >= 0`,
    ),
  ],
);
