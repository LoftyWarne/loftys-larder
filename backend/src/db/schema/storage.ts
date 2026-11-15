import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { households } from './household.ts';
import { ingredients } from './ingredients.ts';
import { mealPlans, mealPlanSlotItems } from './meal-plans.ts';
import { recipes } from './recipes.ts';
import { storageLocation } from './storage-enums.ts';

// What the household holds (DEC-118). The amount is stored, never derived from
// Reservations, so deleting a past plan can't bring settled food back. A zero
// amount is never stored: the procedures and settling delete the row instead.
// The backend never merges rows; the Storage screen combines them for display.
export const stockItems = pgTable(
  'stock_items',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'restrict' }),
    location: storageLocation().notNull(),
    ingredientId: integer().references(() => ingredients.id, {
      onDelete: 'restrict',
    }),
    recipeId: integer().references(() => recipes.id, { onDelete: 'restrict' }),
    quantity: numeric({ precision: 10, scale: 3 }).notNull(),
    addedOn: date({ mode: 'date' }).notNull(),
    useBy: date({ mode: 'date' }),
    // Set by freezing from a plan (FEAT-79). Once made, the item stands on its
    // own, so losing the slot item only drops the link.
    sourceSlotItemId: integer().references(() => mealPlanSlotItems.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    check(
      'stock_items_one_target',
      sql`(${table.ingredientId} is null) <> (${table.recipeId} is null)`,
    ),
    check('stock_items_quantity_positive', sql`${table.quantity} > 0`),
    check(
      'stock_items_use_by_fridge_only',
      sql`${table.useBy} is null or ${table.location} = 'fridge'`,
    ),
    index('stock_items_household_location_idx').on(
      table.householdId,
      table.location,
    ),
    index('stock_items_ingredient_id_idx').on(table.ingredientId),
    index('stock_items_recipe_id_idx').on(table.recipeId),
  ],
);

// An amount of one Stock item set aside for a plan (DEC-118), by a slot item
// or by the plan's shopping line for one ingredient. A shopping line is
// identified by (plan_id, ingredient_id): `shopping_list_items` only holds
// tick state, so a line can exist without a row there. Deleting the stock
// item, slot item or plan releases the Reservation. Due Reservations are
// settled on read (cross-cutting #23).
export const stockReservations = pgTable(
  'stock_reservations',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'restrict' }),
    stockItemId: integer()
      .notNull()
      .references(() => stockItems.id, { onDelete: 'cascade' }),
    planId: integer()
      .notNull()
      .references(() => mealPlans.id, { onDelete: 'cascade' }),
    slotItemId: integer().references(() => mealPlanSlotItems.id, {
      onDelete: 'cascade',
    }),
    ingredientId: integer().references(() => ingredients.id, {
      onDelete: 'restrict',
    }),
    amount: numeric({ precision: 10, scale: 3 }).notNull(),
    neededOn: date({ mode: 'date' }).notNull(),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    check(
      'stock_reservations_one_reserver',
      sql`(${table.slotItemId} is null) <> (${table.ingredientId} is null)`,
    ),
    check('stock_reservations_amount_positive', sql`${table.amount} > 0`),
    index('stock_reservations_household_needed_on_idx').on(
      table.householdId,
      table.neededOn,
    ),
    index('stock_reservations_stock_item_id_idx').on(table.stockItemId),
  ],
);
