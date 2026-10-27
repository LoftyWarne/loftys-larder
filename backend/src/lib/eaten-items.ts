import { type SQL, sql } from 'drizzle-orm';

import {
  mealPlans,
  mealPlanSlotItems,
  mealPlanSlots,
} from '../db/schema/meal-plans.ts';
import { recipes } from '../db/schema/recipes.ts';

// The eaten dishes the day / plan figures are worked out over (DEC-91): rows
// of `(recipe_id, eaten)` with `eaten > 0`. A saved plan's come from its
// slots; Plan Review's come from the proposal as it stands, before anything
// is written (DEC-117). Plant points and the Health Score average take either
// source, so the rules are written once. Both sources are household-scoped
// (DEC-17). `date` narrows to one day; `null` is the whole plan.

export interface EatenDish {
  date: string;
  recipeId: number;
  eaten: number;
}

export function savedEatenItems(
  planId: number,
  householdId: string,
  date: string | null,
): SQL {
  return sql`
    select meal_plan_slot_items.recipe_id, meal_plan_slot_items.eaten
    from ${mealPlanSlots}
    inner join ${mealPlans}
      on meal_plans.id = meal_plan_slots.plan_id
    inner join ${mealPlanSlotItems}
      on meal_plan_slot_items.slot_id = meal_plan_slots.id
      and meal_plan_slot_items.eaten > 0
    where meal_plans.id = ${planId}
      and meal_plans.household_id = ${householdId}
      ${date === null ? sql`` : sql`and meal_plan_slots.date = ${date}::date`}
  `;
}

// The caller passes at least one dish: an empty VALUES list isn't valid SQL.
export function proposedEatenItems(
  dishes: readonly EatenDish[],
  householdId: string,
  date: string | null,
): SQL {
  const rows = sql.join(
    dishes.map(
      (dish) =>
        sql`(${dish.date}::date, ${dish.recipeId}::int, ${dish.eaten}::int)`,
    ),
    sql`, `,
  );
  return sql`
    select proposed.recipe_id, proposed.eaten
    from (values ${rows}) as proposed (date, recipe_id, eaten)
    inner join ${recipes}
      on recipes.id = proposed.recipe_id
      and recipes.household_id = ${householdId}
    where proposed.eaten > 0
      ${date === null ? sql`` : sql`and proposed.date = ${date}::date`}
  `;
}
