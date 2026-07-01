import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.ts';
import { households } from './household.ts';
import { mealOccasions } from './reference.ts';
import { recipes } from './recipes.ts';

// Slot states modelled as a Postgres enum, not as dummy recipes (DEC-25).
// Extending the enum later requires a migration; if a new state is anticipated,
// add it here before shipping. `recipe` now means "home-cooked" — the dishes
// themselves live in `meal_plan_slot_items`.
export const slotType = pgEnum('slot_type', [
  'empty',
  'recipe',
  'eat_out',
  'takeaway',
  'leftovers',
]);

// What a `leftovers` slot is eating. `plan_meal` = leftovers of a dish prepared
// earlier in the plan — the dish lives as the slot's single `eat`
// `meal_plan_slot_items` row (FK to the recipe), so it draws the cooked-base
// pool down (DEC-88) but is excluded from the shopping list (the meal was
// already bought when it was cooked). `takeaway` / `other` carry no recipe —
// they're bare markers. Non-null iff `slot_type = 'leftovers'` (CHECK below).
export const leftoversSource = pgEnum('leftovers_source', [
  'plan_meal',
  'takeaway',
  'other',
]);

// Household-scoped dated window (DEC-17). `created_by_user_id` is informational
// and SET NULL on user delete (DEC-29). The (household_id, start_date) btree
// is what FEAT-27's plan-overlap check (DEC-38) will hit.
export const mealPlans = pgTable(
  'meal_plans',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'restrict' }),
    createdByUserId: text().references(() => users.id, {
      onDelete: 'set null',
    }),
    startDate: date({ mode: 'date' }).notNull(),
    endDate: date({ mode: 'date' }).notNull(),
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
      'meal_plans_start_before_end',
      sql`${table.startDate} <= ${table.endDate}`,
    ),
    index('meal_plans_household_start_date_idx').on(
      table.householdId,
      table.startDate,
    ),
  ],
);

// One row per (plan, date, occasion). The slot carries the occasion's *status*
// (`slot_type`) plus slot-level `chef_user_id` + `comment`; the dishes live in
// `meal_plan_slot_items` (DEC-89). `chef_user_id` is informational; SET NULL on
// user delete (DEC-29).
export const mealPlanSlots = pgTable(
  'meal_plan_slots',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    planId: integer()
      .notNull()
      .references(() => mealPlans.id, { onDelete: 'cascade' }),
    date: date({ mode: 'date' }).notNull(),
    occasionId: smallint()
      .notNull()
      .references(() => mealOccasions.id, { onDelete: 'restrict' }),
    slotType: slotType().notNull(),
    // Set only on `leftovers` slots (CHECK below). For `plan_meal` the eaten
    // dish is the slot's single `eat` item; `takeaway` / `other` are markers.
    leftoversSource: leftoversSource(),
    chefUserId: text().references(() => users.id, { onDelete: 'set null' }),
    comment: text(),
    // Extra diners with no app account (kids, guests). The named household
    // members eating the slot live in `meal_plan_slot_diners`; the headcount the
    // planner shows is `diners + guest_count`, computed, never stored.
    guestCount: smallint().notNull().default(0),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex('meal_plan_slots_plan_date_occasion_unique').on(
      table.planId,
      table.date,
      table.occasionId,
    ),
    check(
      'meal_plan_slots_guest_count_non_negative',
      sql`${table.guestCount} >= 0`,
    ),
    check(
      'meal_plan_slots_leftovers_source_coupling',
      sql`(${table.slotType} = 'leftovers') = (${table.leftoversSource} is not null)`,
    ),
  ],
);

// The household members eating a slot (the "who" behind the headcount). Like
// `chef_user_id` this is informational, never an authorisation predicate
// (DEC-17). The composite PK keeps a member from being added twice. Rows are
// insert/delete-only (the slot editor declares the full set), so there's no
// `updated_at`. The link drops on user delete; the slot + its guest count
// survive, matching the tombstoning intent (DEC-29).
export const mealPlanSlotDiners = pgTable(
  'meal_plan_slot_diners',
  {
    slotId: integer()
      .notNull()
      .references(() => mealPlanSlots.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    primaryKey({ columns: [table.slotId, table.userId] }),
    index('meal_plan_slot_diners_slot_id_idx').on(table.slotId),
  ],
);

// Dishes on a slot (DEC-91). `prepared` = portions cooked, `eaten` = portions
// consumed at this occasion; both `>= 0` with `prepared + eaten > 0`. Role is
// derived, not stored: an item produces surplus when `prepared > eaten` and
// consumes when `eaten > 0`. Application rules (defence-in-depth): a slot is
// `slot_type = 'recipe'` iff it has ≥1 item with `eaten > 0`; prepared-only
// cook-ahead rows are allowed on any slot_type. The shopping list scales by
// `prepared`; the consumption balance (DEC-88) adds `prepared` and subtracts
// `eaten` per recipe.
export const mealPlanSlotItems = pgTable(
  'meal_plan_slot_items',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    slotId: integer()
      .notNull()
      .references(() => mealPlanSlots.id, { onDelete: 'cascade' }),
    recipeId: integer()
      .notNull()
      .references(() => recipes.id, { onDelete: 'restrict' }),
    prepared: smallint().notNull(),
    eaten: smallint().notNull(),
    sortOrder: smallint().notNull(),
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
      'meal_plan_slot_items_prepared_non_negative',
      sql`${table.prepared} >= 0`,
    ),
    check('meal_plan_slot_items_eaten_non_negative', sql`${table.eaten} >= 0`),
    check(
      'meal_plan_slot_items_prepared_or_eaten',
      sql`${table.prepared} + ${table.eaten} > 0`,
    ),
    index('meal_plan_slot_items_slot_id_idx').on(table.slotId),
  ],
);
