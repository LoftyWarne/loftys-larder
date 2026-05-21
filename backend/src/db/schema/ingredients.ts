import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

import { households } from './household.ts';
import { ingredientCategories, unitsOfMeasurement } from './reference.ts';

// Master ingredient list — household-scoped (DEC-17). One enforced unit per
// ingredient (DEC-18): every recipe using this ingredient requests the same
// unit. `isPlant` feeds plant-points, which are computed not stored (DEC-32).
// FKs into reference tables use `smallint` because those PKs are `smallserial`
// (see `reference.ts`); column-type matching is required for the FK to apply.
// The trigram GIN index on `lower(name)` is what FEAT-19's ILIKE search will
// hit; `gin_trgm_ops` can't be expressed through Drizzle's typed DSL, so the
// index is declared as a raw SQL fragment and round-trips through
// drizzle-kit verbatim.
export const ingredients = pgTable(
  'ingredients',
  {
    id: integer().generatedAlwaysAsIdentity().primaryKey(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    categoryId: smallint()
      .notNull()
      .references(() => ingredientCategories.id, { onDelete: 'restrict' }),
    defaultUnitId: smallint()
      .notNull()
      .references(() => unitsOfMeasurement.id, { onDelete: 'restrict' }),
    averageShelfLifeDays: smallint(),
    isPlant: boolean().notNull().default(false),
  },
  (table) => [
    index('ingredients_household_id_idx').on(table.householdId),
    index('ingredients_name_trgm_idx').using(
      'gin',
      sql`lower(${table.name}) gin_trgm_ops`,
    ),
  ],
);
