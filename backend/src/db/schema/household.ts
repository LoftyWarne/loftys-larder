import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

// Single-household MVP (DEC-17). One row is seeded with the
// `CURRENT_HOUSEHOLD_ID` constant from config; every household-scoped table
// added later FKs to `households.id`. Choice of `uuid` over the spec's
// `smallint` is deliberate — see plan file: the SaaS-readiness clause in
// DEC-17 only pays off if the FK type doesn't have to migrate later.
export const households = pgTable('households', {
  id: uuid().primaryKey(),
  name: text().notNull(),
});
