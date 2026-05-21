import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import { households } from '../src/db/schema/household.ts';
import {
  ingredientCategories,
  mealOccasions,
  preparationTypes,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { users } from '../src/db/schema/auth.ts';
import { seedHousehold } from '../src/db/seeds/household.ts';
import {
  INGREDIENT_CATEGORIES,
  MEAL_OCCASIONS,
  PREPARATION_TYPES,
  UNITS_OF_MEASUREMENT,
} from '../src/db/seeds/reference.ts';
import { runSeeds } from '../src/db/seeds/index.ts';
import { makeWithTransaction } from '../src/db/withTransaction.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

describe('schema', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.2-alpine').start();
    pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      max: 2,
    });
    db = drizzle(pool, { schema, casing: 'snake_case' });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    // Reset every table so each test starts from a known empty state.
    // CASCADE clears users → sessions/accounts FKs in one shot.
    await db.execute(sql`
      truncate table
        ${users},
        ${households},
        ${ingredientCategories},
        ${unitsOfMeasurement},
        ${preparationTypes},
        ${mealOccasions}
      restart identity cascade
    `);
  });

  describe('migration shape', () => {
    it('users has the expected columns including theme_preference', async () => {
      const result = await db.execute<{
        column_name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
        column_default: string | null;
      }>(sql`
        select column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public' and table_name = 'users'
        order by ordinal_position
      `);
      const names = result.rows.map((r) => r.column_name);
      expect(names).toEqual([
        'id',
        'name',
        'email',
        'email_verified',
        'image',
        'theme_preference',
        'created_at',
        'updated_at',
      ]);
      const themeRow = result.rows.find(
        (r) => r.column_name === 'theme_preference',
      );
      expect(themeRow?.is_nullable).toBe('NO');
      expect(themeRow?.column_default).toContain("'system'");
    });

    it('households.id is a uuid primary key', async () => {
      const result = await db.execute<{
        column_name: string;
        data_type: string;
      }>(sql`
        select column_name, data_type
        from information_schema.columns
        where table_schema = 'public' and table_name = 'households'
      `);
      const idRow = result.rows.find((r) => r.column_name === 'id');
      expect(idRow?.data_type).toBe('uuid');
    });

    it('every reference table has a unique constraint on name', async () => {
      const tables = [
        'ingredient_categories',
        'units_of_measurement',
        'preparation_types',
        'meal_occasions',
      ];
      for (const table of tables) {
        const result = await db.execute<{ indexname: string }>(sql`
          select indexname
          from pg_indexes
          where schemaname = 'public'
            and tablename = ${table}
            and indexname like ${`${table}_name_unique`}
        `);
        expect(
          result.rows,
          `expected unique index on ${table}(name)`,
        ).toHaveLength(1);
      }
    });
  });

  describe('seeds', () => {
    it('seeds a single households row with CURRENT_HOUSEHOLD_ID', async () => {
      const withTransaction = makeWithTransaction(db);
      await runSeeds(withTransaction);

      const rows = await db.select().from(households);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(CURRENT_HOUSEHOLD_ID);
    });

    it('seeds meal_occasions with exactly Lunch and Dinner', async () => {
      const withTransaction = makeWithTransaction(db);
      await runSeeds(withTransaction);

      const rows = await db
        .select({ name: mealOccasions.name })
        .from(mealOccasions);
      expect(rows.map((r) => r.name).sort()).toEqual(
        [...MEAL_OCCASIONS].sort(),
      );
    });

    it('seeds the opinionated reference lists in full', async () => {
      const withTransaction = makeWithTransaction(db);
      await runSeeds(withTransaction);

      const [cats, units, preps] = await Promise.all([
        db
          .select({ name: ingredientCategories.name })
          .from(ingredientCategories),
        db.select({ name: unitsOfMeasurement.name }).from(unitsOfMeasurement),
        db.select({ name: preparationTypes.name }).from(preparationTypes),
      ]);
      expect(cats.map((r) => r.name).sort()).toEqual(
        [...INGREDIENT_CATEGORIES].sort(),
      );
      expect(units.map((r) => r.name).sort()).toEqual(
        [...UNITS_OF_MEASUREMENT].sort(),
      );
      expect(preps.map((r) => r.name).sort()).toEqual(
        [...PREPARATION_TYPES].sort(),
      );
    });

    it('runSeeds is idempotent across repeated invocations', async () => {
      const withTransaction = makeWithTransaction(db);
      await runSeeds(withTransaction);
      await runSeeds(withTransaction);

      const counts = await db.execute<{ count: string }>(sql`
        select
          (select count(*) from households) as households,
          (select count(*) from ingredient_categories) as ingredient_categories,
          (select count(*) from units_of_measurement) as units_of_measurement,
          (select count(*) from preparation_types) as preparation_types,
          (select count(*) from meal_occasions) as meal_occasions
      `);
      expect(counts.rows).toHaveLength(1);
      expect(counts.rows[0]).toEqual({
        households: '1',
        ingredient_categories: String(INGREDIENT_CATEGORIES.length),
        units_of_measurement: String(UNITS_OF_MEASUREMENT.length),
        preparation_types: String(PREPARATION_TYPES.length),
        meal_occasions: String(MEAL_OCCASIONS.length),
      });
    });

    it('rolls back every insert when a step inside the transaction throws', async () => {
      const withTransaction = makeWithTransaction(db);

      await expect(
        withTransaction(async (tx) => {
          await seedHousehold(tx);
          throw new Error('intentional mid-seed failure');
        }),
      ).rejects.toThrow('intentional mid-seed failure');

      const householdsAfter = await db.select().from(households);
      expect(householdsAfter).toHaveLength(0);
    });
  });

  describe('column-level constraints', () => {
    it('rejects an invalid theme_preference value', async () => {
      const userId = 'test-user-invalid-theme';
      await expect(
        db.execute(sql`
          insert into users (id, name, email, theme_preference)
          values (${userId}, 'x', ${`${userId}@example.com`}, 'midnight')
        `),
      ).rejects.toThrow();
    });

    it('defaults theme_preference to system when the column is omitted', async () => {
      const userId = 'test-user-default-theme';
      await db.execute(sql`
        insert into users (id, name, email)
        values (${userId}, 'x', ${`${userId}@example.com`})
      `);
      const rows = await db
        .select({ themePreference: users.themePreference })
        .from(users);
      expect(rows[0]?.themePreference).toBe('system');
    });

    it('rejects duplicate names in a reference table', async () => {
      await db.insert(ingredientCategories).values({ name: 'Produce' });
      await expect(
        db.insert(ingredientCategories).values({ name: 'Produce' }),
      ).rejects.toThrow();
    });
  });
});
