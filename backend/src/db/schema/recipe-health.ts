import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { recipes } from './recipes.ts';

// One stored AI health score per recipe (DEC-101). Stored, unlike plant points
// (DEC-32), because a model call is slow, costs money and isn't repeatable.
// A separate table, so writing a score never bumps the recipe's
// `date_last_updated`. `is_stale` is set by recipe edits that change what was
// scored; the scorer rewrites the row and clears it.
export const recipeHealthScores = pgTable(
  'recipe_health_scores',
  {
    recipeId: integer()
      .primaryKey()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    score: smallint().notNull(),
    summary: text(),
    model: text().notNull(),
    scoredAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    isStale: boolean().notNull().default(false),
  },
  (table) => [
    check(
      'recipe_health_scores_score_range',
      sql`${table.score} BETWEEN 1 AND 10`,
    ),
  ],
);
