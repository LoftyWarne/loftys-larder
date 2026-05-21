import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  timestamp,
} from 'drizzle-orm/pg-core';

import { ingredients } from './ingredients.ts';
import { mealPlans } from './meal-plans.ts';

// Per-plan-per-ingredient checked state. Rows are lazy-created on first call
// to `shopping.getForPlan(planId)` in FEAT-38 (DEC-30) — this FEAT only
// defines the shape. Quantities are computed from recipes on read; the table
// stores nothing more than the composite-PK pair and the `is_checked` flag
// (plus housekeeping timestamps).
export const shoppingListItems = pgTable(
  'shopping_list_items',
  {
    planId: integer()
      .notNull()
      .references(() => mealPlans.id, { onDelete: 'cascade' }),
    ingredientId: integer()
      .notNull()
      .references(() => ingredients.id, { onDelete: 'restrict' }),
    isChecked: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.planId, table.ingredientId] })],
);
