import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import { users } from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import { ingredients } from '../src/db/schema/ingredients.ts';
import {
  mealPlanSlotItems,
  mealPlanSlots,
  mealPlans,
} from '../src/db/schema/meal-plans.ts';
import { recipes } from '../src/db/schema/recipes.ts';
import {
  ingredientCategories,
  mealOccasions,
  preparationTypes,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { shoppingListItems } from '../src/db/schema/shopping-list.ts';
import { runSeeds } from '../src/db/seeds/index.ts';
import { makeWithTransaction } from '../src/db/withTransaction.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const USER_ID = 'test-user-plan-1';
const OTHER_USER_ID = 'test-user-plan-2';

async function expectConstraintViolation(
  promise: Promise<unknown>,
  expectedConstraint: string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const cause = (err as { cause?: { constraint?: string } }).cause;
    expect(cause?.constraint).toBe(expectedConstraint);
    return;
  }
  throw new Error(
    `expected query to throw with constraint '${expectedConstraint}', but it resolved`,
  );
}

async function seedFixtures(db: NodePgDatabase<Schema>): Promise<{
  occasionId: number;
  ingredientId: number;
}> {
  const withTransaction = makeWithTransaction(db);
  await runSeeds(withTransaction);
  await db.insert(users).values([
    { id: USER_ID, name: 'A', email: 'a@example.com' },
    { id: OTHER_USER_ID, name: 'B', email: 'b@example.com' },
  ]);
  const [occasion] = await db
    .select({ id: mealOccasions.id })
    .from(mealOccasions)
    .limit(1);
  const [category] = await db
    .select({ id: ingredientCategories.id })
    .from(ingredientCategories)
    .limit(1);
  const [unit] = await db
    .select({ id: unitsOfMeasurement.id })
    .from(unitsOfMeasurement)
    .limit(1);
  if (!occasion || !category || !unit) {
    throw new Error('reference data seeded incompletely');
  }
  const [ingredient] = await db
    .insert(ingredients)
    .values({
      householdId: CURRENT_HOUSEHOLD_ID,
      name: 'Onion',
      categoryId: category.id,
      defaultUnitId: unit.id,
    })
    .returning({ id: ingredients.id });
  if (!ingredient) throw new Error('ingredient insert returned no row');
  return { occasionId: occasion.id, ingredientId: ingredient.id };
}

async function insertPlan(
  db: NodePgDatabase<Schema>,
  overrides: Partial<typeof mealPlans.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(mealPlans)
    .values({
      householdId: CURRENT_HOUSEHOLD_ID,
      startDate: new Date('2026-06-01'),
      endDate: new Date('2026-06-07'),
      ...overrides,
    })
    .returning({ id: mealPlans.id });
  if (!row) throw new Error('plan insert returned no row');
  return row.id;
}

async function insertRecipe(
  db: NodePgDatabase<Schema>,
  overrides: Partial<typeof recipes.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(recipes)
    .values({
      householdId: CURRENT_HOUSEHOLD_ID,
      name: 'Test recipe',
      baseServings: 4,
      ...overrides,
    })
    .returning({ id: recipes.id });
  if (!row) throw new Error('recipe insert returned no row');
  return row.id;
}

describe('meal plans and shopping list schema', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.2-alpine').start();
    pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      max: 4,
    });
    db = drizzle(pool, { schema, casing: 'snake_case' });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
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
    it('every new table is present', async () => {
      const result = await db.execute<{ tablename: string }>(sql`
        select tablename from pg_tables where schemaname = 'public'
      `);
      const names = new Set(result.rows.map((r) => r.tablename));
      for (const expected of [
        'meal_plans',
        'meal_plan_slots',
        'meal_plan_slot_items',
        'shopping_list_items',
      ]) {
        expect(names.has(expected), `missing table ${expected}`).toBe(true);
      }
    });

    it('drops the old per-slot recipe + base-cook columns from meal_plan_slots', async () => {
      const result = await db.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'meal_plan_slots'
      `);
      const names = new Set(result.rows.map((r) => r.column_name));
      for (const gone of [
        'recipe_id',
        'number_of_servings',
        'cooks_base_recipe_id',
        'cooks_base_servings',
      ]) {
        expect(names.has(gone), `column ${gone} should be dropped`).toBe(false);
      }
    });

    it('drops the slot_item_kind enum (superseded by prepared/eaten, DEC-91)', async () => {
      const result = await db.execute<{ label: string }>(sql`
        select enumlabel as label
        from pg_enum
        join pg_type on pg_type.oid = pg_enum.enumtypid
        where pg_type.typname = 'slot_item_kind'
      `);
      expect(result.rows).toHaveLength(0);
    });

    it('slot_type enum has exactly the five expected labels', async () => {
      // Guards against accidental re-ordering or label rename on later
      // migrations; the application reads the literal labels.
      const result = await db.execute<{ label: string }>(sql`
        select enumlabel as label
        from pg_enum
        join pg_type on pg_type.oid = pg_enum.enumtypid
        where pg_type.typname = 'slot_type'
        order by pg_enum.enumsortorder
      `);
      expect(result.rows.map((r) => r.label)).toEqual([
        'empty',
        'recipe',
        'eat_out',
        'takeaway',
        'leftovers',
      ]);
    });
  });

  describe('meal_plans CHECK constraints', () => {
    it('accepts a plan with start_date < end_date', async () => {
      await seedFixtures(db);
      await expect(insertPlan(db)).resolves.toBeGreaterThan(0);
    });

    it('accepts a plan with start_date = end_date', async () => {
      await seedFixtures(db);
      await expect(
        insertPlan(db, {
          startDate: new Date('2026-06-01'),
          endDate: new Date('2026-06-01'),
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('rejects a plan with start_date > end_date', async () => {
      await seedFixtures(db);
      await expectConstraintViolation(
        insertPlan(db, {
          startDate: new Date('2026-06-07'),
          endDate: new Date('2026-06-01'),
        }),
        'meal_plans_start_before_end',
      );
    });

    it('allows created_by_user_id NULL', async () => {
      await seedFixtures(db);
      const id = await insertPlan(db, { createdByUserId: null });
      const [row] = await db
        .select({ createdByUserId: mealPlans.createdByUserId })
        .from(mealPlans)
        .where(eq(mealPlans.id, id));
      expect(row?.createdByUserId).toBeNull();
    });
  });

  describe('meal_plans FK ON DELETE behaviour', () => {
    it('sets meal_plans.created_by_user_id to NULL when the user is deleted', async () => {
      await seedFixtures(db);
      const id = await insertPlan(db, { createdByUserId: USER_ID });
      await db.delete(users).where(eq(users.id, USER_ID));
      const [row] = await db
        .select({ createdByUserId: mealPlans.createdByUserId })
        .from(mealPlans)
        .where(eq(mealPlans.id, id));
      expect(row?.createdByUserId).toBeNull();
    });
  });

  describe('meal_plan_slots constraints', () => {
    it('accepts every slot_type (dishes live in items now)', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      const rows = [
        { slotType: 'empty' as const, date: new Date('2026-06-01') },
        { slotType: 'recipe' as const, date: new Date('2026-06-02') },
        { slotType: 'eat_out' as const, date: new Date('2026-06-03') },
        { slotType: 'takeaway' as const, date: new Date('2026-06-04') },
        { slotType: 'leftovers' as const, date: new Date('2026-06-05') },
      ];
      for (const { slotType, date } of rows) {
        await db.insert(mealPlanSlots).values({
          planId,
          date,
          occasionId,
          slotType,
          leftoversSource: slotType === 'leftovers' ? 'other' : null,
        });
      }
      const inserted = await db
        .select({ slotType: mealPlanSlots.slotType })
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.planId, planId));
      expect(inserted).toHaveLength(5);
    });

    it('rejects two slots with the same (plan_id, date, occasion_id)', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      await db.insert(mealPlanSlots).values({
        planId,
        date: new Date('2026-06-01'),
        occasionId,
        slotType: 'empty',
      });
      await expectConstraintViolation(
        db.insert(mealPlanSlots).values({
          planId,
          date: new Date('2026-06-01'),
          occasionId,
          slotType: 'eat_out',
        }),
        'meal_plan_slots_plan_date_occasion_unique',
      );
    });

    it('rejects a leftovers slot without a leftovers_source', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      await expectConstraintViolation(
        db.insert(mealPlanSlots).values({
          planId,
          date: new Date('2026-06-01'),
          occasionId,
          slotType: 'leftovers',
        }),
        'meal_plan_slots_leftovers_source_coupling',
      );
    });

    it('rejects a non-leftovers slot that carries a leftovers_source', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      await expectConstraintViolation(
        db.insert(mealPlanSlots).values({
          planId,
          date: new Date('2026-06-01'),
          occasionId,
          slotType: 'recipe',
          leftoversSource: 'other',
        }),
        'meal_plan_slots_leftovers_source_coupling',
      );
    });

    it('accepts a leftovers slot with a leftovers_source', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      await expect(
        db.insert(mealPlanSlots).values({
          planId,
          date: new Date('2026-06-01'),
          occasionId,
          slotType: 'leftovers',
          leftoversSource: 'plan_meal',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('meal_plan_slot_items', () => {
    async function insertSlot(
      planId: number,
      occasionId: number,
    ): Promise<number> {
      const [slot] = await db
        .insert(mealPlanSlots)
        .values({
          planId,
          date: new Date('2026-06-01'),
          occasionId,
          slotType: 'recipe',
        })
        .returning({ id: mealPlanSlots.id });
      if (!slot) throw new Error('slot insert returned no row');
      return slot.id;
    }

    it('accepts eaten and prepared-only items', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      const slotId = await insertSlot(planId, occasionId);
      const recipeId = await insertRecipe(db);
      const baseId = await insertRecipe(db, { name: 'Base', isBase: true });
      await expect(
        db.insert(mealPlanSlotItems).values([
          { slotId, recipeId, prepared: 2, eaten: 2, sortOrder: 0 },
          {
            slotId,
            recipeId: baseId,
            prepared: 8,
            eaten: 0,
            sortOrder: 1,
          },
        ]),
      ).resolves.toBeDefined();
    });

    it('rejects prepared = 0 and eaten = 0', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      const slotId = await insertSlot(planId, occasionId);
      const recipeId = await insertRecipe(db);
      await expectConstraintViolation(
        db.insert(mealPlanSlotItems).values({
          slotId,
          recipeId,
          prepared: 0,
          eaten: 0,
          sortOrder: 0,
        }),
        'meal_plan_slot_items_prepared_or_eaten',
      );
    });

    it('cascades items when the slot is deleted', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      const slotId = await insertSlot(planId, occasionId);
      const recipeId = await insertRecipe(db);
      await db
        .insert(mealPlanSlotItems)
        .values({ slotId, recipeId, prepared: 2, eaten: 2, sortOrder: 0 });
      await db.delete(mealPlanSlots).where(eq(mealPlanSlots.id, slotId));
      const rows = await db
        .select()
        .from(mealPlanSlotItems)
        .where(eq(mealPlanSlotItems.slotId, slotId));
      expect(rows).toHaveLength(0);
    });

    it('rejects deletion of a recipe referenced by an item (RESTRICT)', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      const slotId = await insertSlot(planId, occasionId);
      const recipeId = await insertRecipe(db);
      await db
        .insert(mealPlanSlotItems)
        .values({ slotId, recipeId, prepared: 2, eaten: 2, sortOrder: 0 });
      await expect(
        db.delete(recipes).where(eq(recipes.id, recipeId)),
      ).rejects.toThrow();
    });
  });

  describe('meal_plan_slots FK ON DELETE behaviour', () => {
    it('cascades slots when the plan is deleted', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      await db.insert(mealPlanSlots).values({
        planId,
        date: new Date('2026-06-01'),
        occasionId,
        slotType: 'empty',
      });
      await db.delete(mealPlans).where(eq(mealPlans.id, planId));
      const rows = await db
        .select()
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.planId, planId));
      expect(rows).toHaveLength(0);
    });

    it('sets chef_user_id to NULL when the user is deleted', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      const [slot] = await db
        .insert(mealPlanSlots)
        .values({
          planId,
          date: new Date('2026-06-01'),
          occasionId,
          slotType: 'empty',
          chefUserId: USER_ID,
        })
        .returning({ id: mealPlanSlots.id });
      if (!slot) throw new Error('slot insert returned no row');
      await db.delete(users).where(eq(users.id, USER_ID));
      const [row] = await db
        .select({ chefUserId: mealPlanSlots.chefUserId })
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.id, slot.id));
      expect(row?.chefUserId).toBeNull();
    });
  });

  describe('shopping_list_items', () => {
    it('defaults is_checked to false when omitted', async () => {
      const { ingredientId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      await db.insert(shoppingListItems).values({ planId, ingredientId });
      const [row] = await db
        .select({ isChecked: shoppingListItems.isChecked })
        .from(shoppingListItems)
        .where(
          and(
            eq(shoppingListItems.planId, planId),
            eq(shoppingListItems.ingredientId, ingredientId),
          ),
        );
      expect(row?.isChecked).toBe(false);
    });

    it('rejects a duplicate (plan_id, ingredient_id) pair', async () => {
      const { ingredientId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      await db.insert(shoppingListItems).values({ planId, ingredientId });
      await expect(
        db.insert(shoppingListItems).values({ planId, ingredientId }),
      ).rejects.toThrow();
    });

    it('cascades shopping list items when the plan is deleted', async () => {
      const { ingredientId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      await db.insert(shoppingListItems).values({ planId, ingredientId });
      await db.delete(mealPlans).where(eq(mealPlans.id, planId));
      const rows = await db
        .select()
        .from(shoppingListItems)
        .where(eq(shoppingListItems.planId, planId));
      expect(rows).toHaveLength(0);
    });

    it('rejects deletion of an ingredient referenced by a shopping_list_items row (RESTRICT)', async () => {
      const { ingredientId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      await db.insert(shoppingListItems).values({ planId, ingredientId });
      await expect(
        db.delete(ingredients).where(eq(ingredients.id, ingredientId)),
      ).rejects.toThrow();
    });
  });

  describe('$onUpdate timestamps', () => {
    it('bumps meal_plans.updated_at on update', async () => {
      await seedFixtures(db);
      const past = new Date('2020-01-01T00:00:00Z');
      const [row] = await db
        .insert(mealPlans)
        .values({
          householdId: CURRENT_HOUSEHOLD_ID,
          startDate: new Date('2026-06-01'),
          endDate: new Date('2026-06-07'),
          updatedAt: past,
        })
        .returning({ id: mealPlans.id });
      if (!row) throw new Error('insert returned no row');
      await db
        .update(mealPlans)
        .set({ endDate: new Date('2026-06-08') })
        .where(eq(mealPlans.id, row.id));
      const [after] = await db
        .select({ updatedAt: mealPlans.updatedAt })
        .from(mealPlans)
        .where(eq(mealPlans.id, row.id));
      expect(after?.updatedAt.getTime()).toBeGreaterThan(past.getTime());
    });

    it('bumps meal_plan_slots.updated_at on update', async () => {
      const { occasionId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      const past = new Date('2020-01-01T00:00:00Z');
      const [row] = await db
        .insert(mealPlanSlots)
        .values({
          planId,
          date: new Date('2026-06-01'),
          occasionId,
          slotType: 'empty',
          updatedAt: past,
        })
        .returning({ id: mealPlanSlots.id });
      if (!row) throw new Error('insert returned no row');
      await db
        .update(mealPlanSlots)
        .set({ slotType: 'eat_out' })
        .where(eq(mealPlanSlots.id, row.id));
      const [after] = await db
        .select({ updatedAt: mealPlanSlots.updatedAt })
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.id, row.id));
      expect(after?.updatedAt.getTime()).toBeGreaterThan(past.getTime());
    });

    it('bumps shopping_list_items.updated_at on update', async () => {
      const { ingredientId } = await seedFixtures(db);
      const planId = await insertPlan(db);
      const past = new Date('2020-01-01T00:00:00Z');
      await db.insert(shoppingListItems).values({
        planId,
        ingredientId,
        updatedAt: past,
      });
      await db
        .update(shoppingListItems)
        .set({ isChecked: true })
        .where(
          and(
            eq(shoppingListItems.planId, planId),
            eq(shoppingListItems.ingredientId, ingredientId),
          ),
        );
      const [after] = await db
        .select({ updatedAt: shoppingListItems.updatedAt })
        .from(shoppingListItems)
        .where(
          and(
            eq(shoppingListItems.planId, planId),
            eq(shoppingListItems.ingredientId, ingredientId),
          ),
        );
      expect(after?.updatedAt.getTime()).toBeGreaterThan(past.getTime());
    });
  });
});
