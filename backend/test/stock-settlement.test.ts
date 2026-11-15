import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import { users } from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import { ingredients } from '../src/db/schema/ingredients.ts';
import { mealPlans } from '../src/db/schema/meal-plans.ts';
import {
  ingredientCategories,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { recipes } from '../src/db/schema/recipes.ts';
import { stockItems, stockReservations } from '../src/db/schema/storage.ts';
import { makeWithTransaction } from '../src/db/withTransaction.ts';
import { addDays, todayInLondon } from '../src/lib/date-utils.ts';
import { settleReservations } from '../src/lib/stock-settlement.ts';
import {
  startTestDb,
  stopTestDb,
  TESTCONTAINER_BOOT_MS,
  type TestDb,
} from './helpers/test-db.ts';

type Schema = typeof schema;

const USER_ID = 'user-stock-settle-1';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009dd';

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
  throw new Error(`expected a '${expectedConstraint}' violation`);
}

describe('stock items and reservations', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let ingredientId!: number;
  let otherIngredientId!: number;
  let recipeId!: number;
  let planId!: number;
  let otherPlanId!: number;
  const today = todayInLondon();

  beforeAll(async () => {
    testDb = await startTestDb({ poolMax: 6 });
    db = testDb.db;
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    await stopTestDb(testDb);
  });

  beforeEach(async () => {
    await db.execute(sql`
      truncate table
        ${stockReservations},
        ${stockItems},
        ${mealPlans},
        ${recipes},
        ${ingredients},
        ${ingredientCategories},
        ${unitsOfMeasurement},
        ${households},
        ${users}
      restart identity cascade
    `);
    await db.insert(households).values([
      { id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" },
      { id: OTHER_HOUSEHOLD_ID, name: 'Other Household' },
    ]);
    await db
      .insert(users)
      .values({ id: USER_ID, name: 'A', email: 'settle@example.com' });
    const [category] = await db
      .insert(ingredientCategories)
      .values({ name: 'Fish' })
      .returning();
    const [unit] = await db
      .insert(unitsOfMeasurement)
      .values({ name: 'g' })
      .returning();
    if (!category || !unit) throw new Error('reference seed failed');
    const inserted = await db
      .insert(ingredients)
      .values([
        {
          householdId: CURRENT_HOUSEHOLD_ID,
          name: 'Cod',
          categoryId: category.id,
          defaultUnitId: unit.id,
        },
        {
          householdId: OTHER_HOUSEHOLD_ID,
          name: 'Cod',
          categoryId: category.id,
          defaultUnitId: unit.id,
        },
      ])
      .returning({ id: ingredients.id });
    ingredientId = inserted[0]?.id ?? 0;
    otherIngredientId = inserted[1]?.id ?? 0;
    const [recipe] = await db
      .insert(recipes)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name: 'Beef Stew Base',
        baseServings: 4,
        isBase: true,
        addedByUserId: USER_ID,
      })
      .returning({ id: recipes.id });
    recipeId = recipe?.id ?? 0;
    const plans = await db
      .insert(mealPlans)
      .values([
        {
          householdId: CURRENT_HOUSEHOLD_ID,
          startDate: addDays(today, -7),
          endDate: addDays(today, 7),
        },
        {
          householdId: OTHER_HOUSEHOLD_ID,
          startDate: addDays(today, -7),
          endDate: addDays(today, 7),
        },
      ])
      .returning({ id: mealPlans.id });
    planId = plans[0]?.id ?? 0;
    otherPlanId = plans[1]?.id ?? 0;
  });

  async function insertItem(
    values: Partial<typeof stockItems.$inferInsert> = {},
  ): Promise<number> {
    const [row] = await db
      .insert(stockItems)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        location: 'freezer',
        ingredientId,
        quantity: '500',
        addedOn: today,
        ...values,
      })
      .returning({ id: stockItems.id });
    if (!row) throw new Error('stock insert failed');
    return row.id;
  }

  async function reserve(
    stockItemId: number,
    amount: string,
    neededOn: Date,
    values: Partial<typeof stockReservations.$inferInsert> = {},
  ): Promise<number> {
    const [row] = await db
      .insert(stockReservations)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        stockItemId,
        planId,
        ingredientId,
        amount,
        neededOn,
        ...values,
      })
      .returning({ id: stockReservations.id });
    if (!row) throw new Error('reservation insert failed');
    return row.id;
  }

  async function quantityOf(id: number): Promise<string | undefined> {
    const rows = await db
      .select({ quantity: stockItems.quantity })
      .from(stockItems)
      .where(eq(stockItems.id, id));
    return rows[0]?.quantity;
  }

  async function settle(): Promise<number> {
    return makeWithTransaction(db)((tx) => settleReservations(tx, today));
  }

  describe('constraints', () => {
    it('needs exactly one of ingredient or recipe', async () => {
      await expectConstraintViolation(
        insertItem({ ingredientId: null, recipeId: null }),
        'stock_items_one_target',
      );
      await expectConstraintViolation(
        insertItem({ recipeId }),
        'stock_items_one_target',
      );
      await expect(
        insertItem({ ingredientId: null, recipeId, quantity: '2' }),
      ).resolves.toBeGreaterThan(0);
    });

    it('needs a positive amount', async () => {
      await expectConstraintViolation(
        insertItem({ quantity: '0' }),
        'stock_items_quantity_positive',
      );
    });

    it('allows a Use-by only in the Fridge', async () => {
      await expectConstraintViolation(
        insertItem({ location: 'freezer', useBy: today }),
        'stock_items_use_by_fridge_only',
      );
      await expectConstraintViolation(
        insertItem({ location: 'pantry', useBy: today }),
        'stock_items_use_by_fridge_only',
      );
      await expect(
        insertItem({ location: 'fridge', useBy: today }),
      ).resolves.toBeGreaterThan(0);
      await expect(
        insertItem({ location: 'fridge', useBy: null }),
      ).resolves.toBeGreaterThan(0);
    });

    it('needs a Reservation to have exactly one reserver and a positive amount', async () => {
      const id = await insertItem();
      await expectConstraintViolation(
        reserve(id, '100', today, { ingredientId: null }),
        'stock_reservations_one_reserver',
      );
      await expectConstraintViolation(
        reserve(id, '0', today),
        'stock_reservations_amount_positive',
      );
    });

    it('releases Reservations when the item or the plan goes', async () => {
      const id = await insertItem();
      await reserve(id, '100', today);
      await db.delete(stockItems).where(eq(stockItems.id, id));
      expect(await db.select().from(stockReservations)).toHaveLength(0);

      const second = await insertItem();
      await reserve(second, '100', today);
      await db.delete(mealPlans).where(eq(mealPlans.id, planId));
      expect(await db.select().from(stockReservations)).toHaveLength(0);
      expect(await quantityOf(second)).toBe('500.000');
    });
  });

  describe('settling', () => {
    it('settles only Reservations due before today', async () => {
      const id = await insertItem({ quantity: '500' });
      await reserve(id, '100', addDays(today, -1));
      await reserve(id, '50', addDays(today, -3));
      const todays = await reserve(id, '200', today);
      const tomorrows = await reserve(id, '25', addDays(today, 1));

      expect(await settle()).toBe(2);
      expect(await quantityOf(id)).toBe('350.000');
      const left = await db
        .select({ id: stockReservations.id })
        .from(stockReservations);
      expect(left.map((row) => row.id).sort()).toEqual(
        [todays, tomorrows].sort(),
      );
    });

    it('deletes an item that reaches zero, with its remaining Reservations', async () => {
      const id = await insertItem({ quantity: '100' });
      await reserve(id, '100', addDays(today, -1));
      const kept = await insertItem({ quantity: '300' });
      await reserve(kept, '100', addDays(today, -1));

      await settle();
      expect(await quantityOf(id)).toBeUndefined();
      expect(await quantityOf(kept)).toBe('200.000');
    });

    it('is idempotent', async () => {
      const id = await insertItem({ quantity: '500' });
      await reserve(id, '100', addDays(today, -1));
      expect(await settle()).toBe(1);
      expect(await settle()).toBe(0);
      expect(await quantityOf(id)).toBe('400.000');
    });

    it('leaves other households alone', async () => {
      const [foreign] = await db
        .insert(stockItems)
        .values({
          householdId: OTHER_HOUSEHOLD_ID,
          location: 'freezer',
          ingredientId: otherIngredientId,
          quantity: '500',
          addedOn: today,
        })
        .returning({ id: stockItems.id });
      if (!foreign) throw new Error('foreign insert failed');
      await db.insert(stockReservations).values({
        householdId: OTHER_HOUSEHOLD_ID,
        stockItemId: foreign.id,
        planId: otherPlanId,
        ingredientId: otherIngredientId,
        amount: '100',
        neededOn: addDays(today, -1),
      });

      expect(await settle()).toBe(0);
      expect(await quantityOf(foreign.id)).toBe('500.000');
    });

    it('counts a Reservation once when two settles run at once', async () => {
      const id = await insertItem({ quantity: '1000' });
      for (let day = 1; day <= 5; day += 1) {
        await reserve(id, '100', addDays(today, -day));
      }
      const withTransaction = makeWithTransaction(db);

      // The first settle holds its transaction open, so the second's settle
      // starts while the first's row locks are still held, and has to wait.
      let commitFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => {
        commitFirst = resolve;
      });
      let firstSettled!: () => void;
      const firstHasSettled = new Promise<void>((resolve) => {
        firstSettled = resolve;
      });
      const first = withTransaction(async (tx) => {
        const count = await settleReservations(tx, today);
        firstSettled();
        await firstMayCommit;
        return count;
      });
      await firstHasSettled;
      const second = withTransaction((tx) => settleReservations(tx, today));
      await new Promise((resolve) => setTimeout(resolve, 200));
      commitFirst();

      expect(await first).toBe(5);
      expect(await second).toBe(0);
      expect(await quantityOf(id)).toBe('500.000');
    });

    it('settles against an edit committed while it waited', async () => {
      const cases = [
        { before: '500', after: '200', left: undefined },
        { before: '200', after: '500', left: '200.000' },
      ];
      for (const { before, after, left } of cases) {
        const id = await insertItem({ quantity: before });
        await reserve(id, '300', addDays(today, -1));
        const withTransaction = makeWithTransaction(db);
        let commitEdit!: () => void;
        const editMayCommit = new Promise<void>((resolve) => {
          commitEdit = resolve;
        });
        let edited!: () => void;
        const hasEdited = new Promise<void>((resolve) => {
          edited = resolve;
        });
        const editing = withTransaction(async (tx) => {
          await tx
            .update(stockItems)
            .set({ quantity: after })
            .where(eq(stockItems.id, id));
          edited();
          await editMayCommit;
        });
        await hasEdited;
        const settling = settle();
        await new Promise((resolve) => setTimeout(resolve, 200));
        commitEdit();
        await editing;

        expect(await settling).toBe(1);
        expect(await quantityOf(id)).toBe(left);
      }
    });

    it('counts once when two settles race through the helper', async () => {
      const id = await insertItem({ quantity: '1000' });
      for (let day = 1; day <= 5; day += 1) {
        await reserve(id, '100', addDays(today, -day));
      }
      const results = await Promise.all([settle(), settle(), settle()]);
      expect(results.reduce((sum, count) => sum + count, 0)).toBe(5);
      expect(await quantityOf(id)).toBe('500.000');
    });
  });
});
