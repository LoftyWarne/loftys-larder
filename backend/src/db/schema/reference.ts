import { pgTable, smallserial, text, uniqueIndex } from 'drizzle-orm/pg-core';

// Reference tables are read-only enums-with-attributes. Minimal shape:
// `smallserial id` PK, `text name UNIQUE NOT NULL`. Seeded once in
// `backend/src/db/seeds/reference.ts`. No timestamps — these rows don't
// evolve in the running app.
export const ingredientCategories = pgTable(
  'ingredient_categories',
  {
    id: smallserial().primaryKey(),
    name: text().notNull(),
  },
  (table) => [uniqueIndex('ingredient_categories_name_unique').on(table.name)],
);

export const unitsOfMeasurement = pgTable(
  'units_of_measurement',
  {
    id: smallserial().primaryKey(),
    name: text().notNull(),
  },
  (table) => [uniqueIndex('units_of_measurement_name_unique').on(table.name)],
);

export const preparationTypes = pgTable(
  'preparation_types',
  {
    id: smallserial().primaryKey(),
    name: text().notNull(),
  },
  (table) => [uniqueIndex('preparation_types_name_unique').on(table.name)],
);

export const mealOccasions = pgTable(
  'meal_occasions',
  {
    id: smallserial().primaryKey(),
    name: text().notNull(),
  },
  (table) => [uniqueIndex('meal_occasions_name_unique').on(table.name)],
);
