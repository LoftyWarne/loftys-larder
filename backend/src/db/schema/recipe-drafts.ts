import { sql } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { users } from './auth.ts';
import { recipes } from './recipes.ts';

// Server-side autosave for the recipe editor (FEAT-21). `UNIQUE (user_id,
// recipe_id)` relies on Postgres's NULL-distinct default: two rows with the
// same `user_id` and `recipe_id IS NULL` are both allowed, so a user can
// have multiple in-progress new-recipe drafts.
//
// `user_id` is RESTRICT so account-deletion (FEAT-35) has to clear drafts
// explicitly — matches the tombstoning sequence (DEC-29, `docs/plan.md`
// step 6).
export const recipeDrafts = pgTable(
  'recipe_drafts',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recipeId: integer().references(() => recipes.id, {
      onDelete: 'restrict',
    }),
    draftData: jsonb().notNull(),
    lastUpdatedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('recipe_drafts_user_recipe_unique').on(
      table.userId,
      table.recipeId,
    ),
  ],
);
