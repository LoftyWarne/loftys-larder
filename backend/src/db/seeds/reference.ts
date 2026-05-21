import {
  ingredientCategories,
  mealOccasions,
  preparationTypes,
  unitsOfMeasurement,
} from '../schema/reference.ts';
import type { Tx } from '../withTransaction.ts';

// Opinionated MVP seed sets. Editable by the user — these are the rows the
// app starts life with, not the rows it's locked to. `meal_occasions` is the
// only set the spec mandates; the others were greenlit in plan kickoff.
export const INGREDIENT_CATEGORIES = [
  'Fruit & Veg',
  'Dairy',
  'Meat',
  'Fish',
  'Pantry',
  'Frozen',
  'Bakery',
  'Drinks',
] as const;

export const UNITS_OF_MEASUREMENT = [
  'g',
  'kg',
  'ml',
  'l',
  'tsp',
  'tbsp',
  'piece',
  'pinch',
  'cup',
] as const;

export const PREPARATION_TYPES = [
  'raw',
  'chopped',
  'diced',
  'sliced',
  'minced',
  'grated',
] as const;

export const MEAL_OCCASIONS = ['Lunch', 'Dinner'] as const;

export async function seedReference(tx: Tx): Promise<void> {
  await tx
    .insert(ingredientCategories)
    .values(INGREDIENT_CATEGORIES.map((name) => ({ name })))
    .onConflictDoNothing({ target: ingredientCategories.name });
  await tx
    .insert(unitsOfMeasurement)
    .values(UNITS_OF_MEASUREMENT.map((name) => ({ name })))
    .onConflictDoNothing({ target: unitsOfMeasurement.name });
  await tx
    .insert(preparationTypes)
    .values(PREPARATION_TYPES.map((name) => ({ name })))
    .onConflictDoNothing({ target: preparationTypes.name });
  await tx
    .insert(mealOccasions)
    .values(MEAL_OCCASIONS.map((name) => ({ name })))
    .onConflictDoNothing({ target: mealOccasions.name });
}
