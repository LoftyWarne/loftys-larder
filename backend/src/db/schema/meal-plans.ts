import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
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
// add it here before shipping.
export const slotType = pgEnum('slot_type', [
  'empty',
  'recipe',
  'eat_out',
  'takeaway',
  'leftovers',
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
    name: text().notNull(),
    startDate: date({ mode: 'date' }).notNull(),
    endDate: date({ mode: 'date' }).notNull(),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
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

// One row per (plan, date, occasion). Two independent recipe FKs:
//   - `recipe_id`        — what the slot is *eating*. Required iff
//                          `slot_type = 'recipe'` (biconditional CHECK).
//   - `cooks_base_recipe_id` — an independently-prepped base (DEC-24), joint-set
//                              with `cooks_base_servings`, RESTRICT-protected.
//
// `cooks_base_recipe_id` must reference a recipe with `is_base = true` —
// enforced in FEAT-30's application code, deliberately not in a DB trigger
// (spec implementation notes). `chef_user_id` is informational; SET NULL on
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
    recipeId: integer().references(() => recipes.id, { onDelete: 'restrict' }),
    numberOfServings: smallint(),
    chefUserId: text().references(() => users.id, { onDelete: 'set null' }),
    cooksBaseRecipeId: integer().references(() => recipes.id, {
      onDelete: 'restrict',
    }),
    cooksBaseServings: smallint(),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('meal_plan_slots_plan_date_occasion_unique').on(
      table.planId,
      table.date,
      table.occasionId,
    ),
    check(
      'meal_plan_slots_recipe_iff_type',
      sql`(${table.slotType} = 'recipe') = (${table.recipeId} IS NOT NULL)`,
    ),
    check(
      'meal_plan_slots_servings_when_recipe',
      sql`${table.slotType} <> 'recipe' OR (${table.numberOfServings} IS NOT NULL AND ${table.numberOfServings} > 0)`,
    ),
    check(
      'meal_plan_slots_cooks_base_joint',
      sql`(${table.cooksBaseRecipeId} IS NULL) = (${table.cooksBaseServings} IS NULL) AND (${table.cooksBaseServings} IS NULL OR ${table.cooksBaseServings} > 0)`,
    ),
  ],
);
