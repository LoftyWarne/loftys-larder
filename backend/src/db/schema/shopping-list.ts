import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
} from 'drizzle-orm/pg-core';

import { ingredients } from './ingredients.ts';
import { mealPlans } from './meal-plans.ts';

// Per-plan-per-ingredient checked state. Rows are lazy-created on the first
// call to `shopping.getForPlan(planId)` (DEC-30). Quantities themselves are
// recomputed from recipes on every read — the table only persists `isChecked`
// plus `lastCheckedQuantity`, the aggregated total recorded at the moment the
// line was checked. On a subsequent aggregation, a mismatch between the
// current total and `lastCheckedQuantity` silently resets the check (DEC-31).
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
    lastCheckedQuantity: numeric({ precision: 10, scale: 3 }),
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
