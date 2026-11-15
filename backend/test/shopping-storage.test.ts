import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { StapleState, StorageLocation } from '../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import {
  accounts,
  sessions,
  users,
  verifications,
} from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import { ingredients } from '../src/db/schema/ingredients.ts';
import {
  mealPlans,
  mealPlanSlotItems,
  mealPlanSlots,
} from '../src/db/schema/meal-plans.ts';
import {
  ingredientCategories,
  mealOccasions,
  preparationTypes,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { recipeIngredients, recipes } from '../src/db/schema/recipes.ts';
import { shoppingListItems } from '../src/db/schema/shopping-list.ts';
import { stockItems, stockReservations } from '../src/db/schema/storage.ts';
import { makeWithTransaction, type Tx } from '../src/db/withTransaction.ts';
import {
  addDays,
  formatCivilDate,
  todayInLondon,
} from '../src/lib/date-utils.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { appRouter } from '../src/trpc/router.ts';
import { contextDeps } from './helpers/context-deps.ts';
import {
  startTestDb,
  stopTestDb,
  TESTCONTAINER_BOOT_MS,
  type TestDb,
} from './helpers/test-db.ts';

type Schema = typeof schema;

const USER_ID = 'user-shopping-storage-1';
const USER_EMAIL = 'shopping-storage@example.com';

function domainCode(error: unknown): unknown {
  if (!(error instanceof TRPCError)) return undefined;
  return (error.cause as { code?: unknown } | undefined)?.code;
}

async function expectDomainError(
  promise: Promise<unknown>,
  code: string,
): Promise<TRPCError> {
  try {
    await promise;
  } catch (error) {
    expect(domainCode(error)).toBe(code);
    return error as TRPCError;
  }
  throw new Error(`expected ${code}`);
}

describe('shopping against storage, and Staples', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let dinnerId!: number;
  let categoryId!: number;
  let gramsId!: number;
  const today = todayInLondon();
  const day = (offset: number): Date => addDays(today, offset);
  const iso = (offset: number): string => formatCivilDate(day(offset));

  beforeAll(async () => {
    testDb = await startTestDb({ poolMax: 4 });
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
        ${shoppingListItems},
        ${mealPlanSlots},
        ${mealPlans},
        ${recipeIngredients},
        ${recipes},
        ${ingredients},
        ${ingredientCategories},
        ${unitsOfMeasurement},
        ${preparationTypes},
        ${mealOccasions},
        ${households},
        ${users},
        ${sessions},
        ${accounts},
        ${verifications}
      restart identity cascade
    `);
    await db
      .insert(households)
      .values({ id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" });
    await db.insert(users).values({
      id: USER_ID,
      email: USER_EMAIL,
      name: 'Storage Shopper',
      emailVerified: true,
    });
    const [dinner] = await db
      .insert(mealOccasions)
      .values({ name: 'Dinner' })
      .returning({ id: mealOccasions.id });
    const [category] = await db
      .insert(ingredientCategories)
      .values({ name: 'Fish' })
      .returning({ id: ingredientCategories.id });
    const [grams] = await db
      .insert(unitsOfMeasurement)
      .values({ name: 'g' })
      .returning({ id: unitsOfMeasurement.id });
    if (!dinner || !category || !grams) throw new Error('seed failed');
    dinnerId = dinner.id;
    categoryId = category.id;
    gramsId = grams.id;
  });

  function caller() {
    const context: AppContext = {
      req: {} as AppContext['req'],
      reply: {} as AppContext['reply'],
      reqId: 'rid-test',
      ...contextDeps(),
      db,
      cloudinary: { cloudName: 'c', apiKey: 'k', apiSecret: 's' },
      session: {
        id: 'session-shopping-storage',
        userId: USER_ID,
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
        ipAddress: null,
        userAgent: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: USER_ID,
        email: USER_EMAIL,
        name: 'Storage Shopper',
        emailVerified: true,
        image: null,
        themePreference: 'system',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
    return appRouter.createCaller(context);
  }

  async function insertIngredient(
    name: string,
    staple?: { state: StapleState; location: StorageLocation },
  ): Promise<number> {
    const [row] = await db
      .insert(ingredients)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name,
        categoryId,
        defaultUnitId: gramsId,
        averageShelfLifeDays: 2,
        stapleState: staple?.state ?? null,
        stapleLocation: staple?.location ?? null,
      })
      .returning({ id: ingredients.id });
    if (!row) throw new Error('ingredient insert failed');
    return row.id;
  }

  // A recipe for 1 serving using `quantity` of the ingredient.
  async function insertRecipe(
    name: string,
    ingredientId: number,
    quantity: string,
  ): Promise<number> {
    const [row] = await db
      .insert(recipes)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name,
        baseServings: 1,
        addedByUserId: USER_ID,
      })
      .returning({ id: recipes.id });
    if (!row) throw new Error('recipe insert failed');
    await db
      .insert(recipeIngredients)
      .values({ recipeId: row.id, ingredientId, quantity });
    return row.id;
  }

  async function insertPlan(start: number, end: number): Promise<number> {
    const [row] = await db
      .insert(mealPlans)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        createdByUserId: USER_ID,
        startDate: day(start),
        endDate: day(end),
      })
      .returning({ id: mealPlans.id });
    if (!row) throw new Error('plan insert failed');
    return row.id;
  }

  async function insertSlot(
    planId: number,
    offset: number,
    recipeId: number,
  ): Promise<{ slotId: number; itemId: number }> {
    const [slot] = await db
      .insert(mealPlanSlots)
      .values({
        planId,
        date: day(offset),
        occasionId: dinnerId,
        slotType: 'recipe',
      })
      .returning({ id: mealPlanSlots.id });
    if (!slot) throw new Error('slot insert failed');
    const [item] = await db
      .insert(mealPlanSlotItems)
      .values({
        slotId: slot.id,
        recipeId,
        prepared: 1,
        eaten: 1,
        sortOrder: 0,
      })
      .returning({ id: mealPlanSlotItems.id });
    if (!item) throw new Error('slot item insert failed');
    return { slotId: slot.id, itemId: item.id };
  }

  async function insertStock(
    ingredientId: number,
    location: StorageLocation,
    quantity: string,
    options: { addedOn?: number; useBy?: number } = {},
  ): Promise<number> {
    const [row] = await db
      .insert(stockItems)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        location,
        ingredientId,
        quantity,
        addedOn: day(options.addedOn ?? -10),
        useBy: location === 'fridge' ? day(options.useBy ?? 3) : null,
      })
      .returning({ id: stockItems.id });
    if (!row) throw new Error('stock insert failed');
    return row.id;
  }

  async function lineReservations(planId: number, ingredientId: number) {
    return db
      .select({
        stockItemId: stockReservations.stockItemId,
        amount: stockReservations.amount,
        neededOn: stockReservations.neededOn,
      })
      .from(stockReservations)
      .where(
        and(
          eq(stockReservations.planId, planId),
          eq(stockReservations.ingredientId, ingredientId),
        ),
      )
      .orderBy(stockReservations.stockItemId);
  }

  async function stockQuantity(id: number): Promise<string | undefined> {
    const [row] = await db
      .select({ quantity: stockItems.quantity })
      .from(stockItems)
      .where(eq(stockItems.id, id));
    return row?.quantity;
  }

  async function stapleState(id: number) {
    const [row] = await db
      .select({ state: ingredients.stapleState })
      .from(ingredients)
      .where(eq(ingredients.id, id));
    return row?.state;
  }

  async function line(planId: number, ingredientId: number) {
    const list = await caller().shopping.getForPlan({ planId });
    return list.categories
      .flatMap((cat) => cat.lines)
      .find((entry) => entry.ingredient.id === ingredientId);
  }

  // Cod: 500 g in the Freezer, a dish tomorrow needing 400 g.
  async function codScenario() {
    const codId = await insertIngredient('Cod');
    const recipeId = await insertRecipe('Fish Pie', codId, '400');
    const planId = await insertPlan(0, 6);
    const slot = await insertSlot(planId, 1, recipeId);
    const freezerId = await insertStock(codId, 'freezer', '500');
    return { codId, recipeId, planId, freezerId, ...slot };
  }

  describe('holdings on a line', () => {
    it('lists the held Stock items with what the line could take', async () => {
      const { codId, planId, freezerId } = await codScenario();
      const cod = await line(planId, codId);
      expect(cod).toMatchObject({
        totalQuantity: '400.000',
        reserved: '0.000',
        leftToBuy: '400.000',
        fromStorage: false,
        stockItems: [
          {
            stockItemId: freezerId,
            location: 'freezer',
            available: '500.000',
            reservedByLine: '0.000',
          },
        ],
      });
    });

    it('takes other Reservations off what is available, and leaves out recipe stock', async () => {
      const { codId, planId, recipeId, freezerId } = await codScenario();
      await db.insert(stockItems).values({
        householdId: CURRENT_HOUSEHOLD_ID,
        location: 'freezer',
        recipeId,
        quantity: '2',
        addedOn: day(-1),
      });
      const otherPlan = await insertPlan(7, 10);
      await insertSlot(otherPlan, 8, recipeId);
      await caller().shopping.setLineReservations({
        planId: otherPlan,
        ingredientId: codId,
        choice: { kind: 'amount', amount: '300' },
      });

      const cod = await line(planId, codId);
      expect(cod?.stockItems).toEqual([
        expect.objectContaining({
          stockItemId: freezerId,
          available: '200.000',
        }),
      ]);
    });

    it('shows no Stock items when nothing is held', async () => {
      const codId = await insertIngredient('Cod');
      const recipeId = await insertRecipe('Fish Pie', codId, '400');
      const planId = await insertPlan(0, 6);
      await insertSlot(planId, 1, recipeId);
      expect((await line(planId, codId))?.stockItems).toEqual([]);
    });
  });

  describe('the three choices', () => {
    it('Use from storage reserves the line’s amount, needed on the first slot', async () => {
      const { codId, planId, freezerId } = await codScenario();
      const result = await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });
      expect(result.reserved).toBe('400.000');

      const reservations = await lineReservations(planId, codId);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]?.amount).toBe('400.000');
      const neededOn = reservations[0]?.neededOn;
      expect(neededOn && formatCivilDate(neededOn)).toBe(iso(1));

      const cod = await line(planId, codId);
      expect(cod).toMatchObject({
        reserved: '400.000',
        leftToBuy: '0.000',
        fromStorage: true,
      });
      expect(cod?.shelfLifeWarning).toBeUndefined();

      const storage = await caller().storage.list();
      expect(storage.items.find((item) => item.id === freezerId)).toMatchObject(
        { quantity: '500.000', reserved: '400.000' },
      );
    });

    it('Use from storage takes all that is available when it is less', async () => {
      const codId = await insertIngredient('Cod');
      const recipeId = await insertRecipe('Fish Pie', codId, '400');
      const planId = await insertPlan(0, 6);
      await insertSlot(planId, 1, recipeId);
      await insertStock(codId, 'freezer', '150');

      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });
      expect(await line(planId, codId)).toMatchObject({
        reserved: '150.000',
        leftToBuy: '250.000',
        fromStorage: false,
      });
    });

    it('Buy anyway reserves nothing, and releases what was reserved', async () => {
      const { codId, planId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'none' },
      });
      expect(await lineReservations(planId, codId)).toEqual([]);
      expect(await line(planId, codId)).toMatchObject({
        reserved: '0.000',
        leftToBuy: '400.000',
      });
    });

    it('Use some, buy the rest reserves the amount entered', async () => {
      const { codId, planId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'amount', amount: '250' },
      });
      expect(await line(planId, codId)).toMatchObject({
        reserved: '250.000',
        leftToBuy: '150.000',
      });
    });

    it('refuses an amount over what is needed or held', async () => {
      const { codId, planId } = await codScenario();
      const error = await expectDomainError(
        caller().shopping.setLineReservations({
          planId,
          ingredientId: codId,
          choice: { kind: 'amount', amount: '450' },
        }),
        'SHOPPING_RESERVE_TOO_MUCH',
      );
      expect(error.cause).toMatchObject({
        available: '500.000',
        needed: '400.000',
      });
      expect(await lineReservations(planId, codId)).toEqual([]);
    });

    it('refuses an ingredient the plan doesn’t need', async () => {
      const { planId } = await codScenario();
      const otherId = await insertIngredient('Haddock');
      await insertStock(otherId, 'freezer', '200');
      await expectDomainError(
        caller().shopping.setLineReservations({
          planId,
          ingredientId: otherId,
          choice: { kind: 'all' },
        }),
        'SHOPPING_INGREDIENT_NOT_IN_PLAN',
      );
    });
  });

  describe('which items it draws from', () => {
    it('draws Fridge items by soonest Use-by, then the oldest Freezer and Pantry items', async () => {
      const codId = await insertIngredient('Cod');
      const recipeId = await insertRecipe('Fish Pie', codId, '1000');
      const planId = await insertPlan(0, 6);
      await insertSlot(planId, 1, recipeId);
      const newerFreezer = await insertStock(codId, 'freezer', '300', {
        addedOn: -5,
      });
      const olderPantry = await insertStock(codId, 'pantry', '300', {
        addedOn: -20,
      });
      const laterFridge = await insertStock(codId, 'fridge', '200', {
        useBy: 4,
      });
      const soonerFridge = await insertStock(codId, 'fridge', '100', {
        useBy: 1,
      });

      const cod = await line(planId, codId);
      expect(cod?.stockItems.map((item) => item.stockItemId)).toEqual([
        soonerFridge,
        laterFridge,
        olderPantry,
        newerFreezer,
      ]);

      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'amount', amount: '500' },
      });
      const byItem = new Map(
        (await lineReservations(planId, codId)).map((row) => [
          row.stockItemId,
          row.amount,
        ]),
      );
      expect(byItem).toEqual(
        new Map([
          [soonerFridge, '100.000'],
          [laterFridge, '200.000'],
          [olderPantry, '200.000'],
        ]),
      );
    });

    it('takes the cook’s own choice of items', async () => {
      const codId = await insertIngredient('Cod');
      const recipeId = await insertRecipe('Fish Pie', codId, '400');
      const planId = await insertPlan(0, 6);
      await insertSlot(planId, 1, recipeId);
      await insertStock(codId, 'fridge', '300');
      const freezerId = await insertStock(codId, 'freezer', '300');
      const pantryId = await insertStock(codId, 'pantry', '300');

      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: {
          kind: 'draws',
          draws: [
            { stockItemId: freezerId, amount: '250' },
            { stockItemId: pantryId, amount: '150' },
          ],
        },
      });
      expect(await lineReservations(planId, codId)).toEqual([
        expect.objectContaining({ stockItemId: freezerId, amount: '250.000' }),
        expect.objectContaining({ stockItemId: pantryId, amount: '150.000' }),
      ]);
    });

    it('refuses a draw over an item’s available amount, or from an item it can’t use', async () => {
      const { codId, planId, freezerId } = await codScenario();
      await expectDomainError(
        caller().shopping.setLineReservations({
          planId,
          ingredientId: codId,
          choice: {
            kind: 'draws',
            draws: [{ stockItemId: freezerId, amount: '600' }],
          },
        }),
        'SHOPPING_RESERVE_TOO_MUCH',
      );
      const haddockId = await insertIngredient('Haddock');
      const haddockStock = await insertStock(haddockId, 'freezer', '100');
      await expectDomainError(
        caller().shopping.setLineReservations({
          planId,
          ingredientId: codId,
          choice: {
            kind: 'draws',
            draws: [{ stockItemId: haddockStock, amount: '50' }],
          },
        }),
        'STOCK_ITEM_NOT_FOUND',
      );
    });

    it('lets a second plan reserve only what the first left', async () => {
      const { codId, recipeId, planId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });
      const secondPlan = await insertPlan(7, 10);
      await insertSlot(secondPlan, 8, recipeId);

      await caller().shopping.setLineReservations({
        planId: secondPlan,
        ingredientId: codId,
        choice: { kind: 'all' },
      });
      expect(await line(secondPlan, codId)).toMatchObject({
        reserved: '100.000',
        leftToBuy: '300.000',
      });
    });
  });

  describe('when it leaves storage', () => {
    it('moves `needed_on` with the first slot that uses the ingredient', async () => {
      const { codId, planId, slotId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });
      await db
        .update(mealPlanSlots)
        .set({ date: day(3) })
        .where(eq(mealPlanSlots.id, slotId));

      await caller().shopping.getForPlan({ planId });
      const [reservation] = await lineReservations(planId, codId);
      expect(reservation && formatCivilDate(reservation.neededOn)).toBe(iso(3));
    });

    it('settles once the day has passed, leaving what was not used', async () => {
      const codId = await insertIngredient('Cod');
      const recipeId = await insertRecipe('Fish Pie', codId, '400');
      const planId = await insertPlan(-3, 3);
      await insertSlot(planId, -1, recipeId);
      const freezerId = await insertStock(codId, 'freezer', '500');

      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });
      await caller().shopping.getForPlan({ planId });

      expect(await stockQuantity(freezerId)).toBe('100.000');
      expect(await lineReservations(planId, codId)).toEqual([]);
    });
  });

  describe('releasing', () => {
    it('releases the excess when the plan needs less, the last-drawn item first', async () => {
      const codId = await insertIngredient('Cod');
      const recipeId = await insertRecipe('Fish Pie', codId, '400');
      const planId = await insertPlan(0, 6);
      await insertSlot(planId, 1, recipeId);
      const fridgeId = await insertStock(codId, 'fridge', '250');
      const freezerId = await insertStock(codId, 'freezer', '500');
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });

      await db
        .update(recipeIngredients)
        .set({ quantity: '300' })
        .where(eq(recipeIngredients.recipeId, recipeId));
      expect(await line(planId, codId)).toMatchObject({
        reserved: '300.000',
        leftToBuy: '0.000',
      });
      expect(await lineReservations(planId, codId)).toEqual([
        expect.objectContaining({ stockItemId: fridgeId, amount: '250.000' }),
        expect.objectContaining({ stockItemId: freezerId, amount: '50.000' }),
      ]);
    });

    it('keeps the cook’s amount when the plan needs more', async () => {
      const { codId, recipeId, planId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'amount', amount: '200' },
      });
      await db
        .update(recipeIngredients)
        .set({ quantity: '450' })
        .where(eq(recipeIngredients.recipeId, recipeId));
      expect(await line(planId, codId)).toMatchObject({
        reserved: '200.000',
        leftToBuy: '250.000',
      });
    });

    it('releases everything when the plan stops needing the ingredient', async () => {
      const { codId, planId, itemId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });
      await db
        .delete(mealPlanSlotItems)
        .where(eq(mealPlanSlotItems.id, itemId));

      await caller().shopping.getForPlan({ planId });
      expect(await lineReservations(planId, codId)).toEqual([]);
    });
  });

  describe('ticks', () => {
    it('never create, change or settle a Reservation', async () => {
      const { codId, planId, freezerId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'amount', amount: '100' },
      });
      const before = await lineReservations(planId, codId);

      await caller().shopping.toggleChecked({
        planId,
        ingredientId: codId,
        isChecked: true,
      });
      expect(await lineReservations(planId, codId)).toEqual(before);
      expect(await stockQuantity(freezerId)).toBe('500.000');

      await caller().shopping.toggleChecked({
        planId,
        ingredientId: codId,
        isChecked: false,
      });
      expect(await lineReservations(planId, codId)).toEqual(before);
      expect(await stockQuantity(freezerId)).toBe('500.000');
    });

    it('record what is left to buy, so reserving more afterwards resets the tick', async () => {
      const { codId, planId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'amount', amount: '100' },
      });
      await caller().shopping.toggleChecked({
        planId,
        ingredientId: codId,
        isChecked: true,
      });
      const [row] = await db
        .select({ last: shoppingListItems.lastCheckedQuantity })
        .from(shoppingListItems)
        .where(eq(shoppingListItems.ingredientId, codId));
      expect(row?.last).toBe('300.000');
      expect((await line(planId, codId))?.isChecked).toBe(true);

      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'amount', amount: '200' },
      });
      expect((await line(planId, codId))?.isChecked).toBe(false);
    });
  });

  describe('Staples on the list', () => {
    it('lists running-low and out Staples to restock on a current plan, needed or not', async () => {
      const oilId = await insertIngredient('Olive Oil', {
        state: 'running_low',
        location: 'pantry',
      });
      const saltId = await insertIngredient('Salt', {
        state: 'out',
        location: 'pantry',
      });
      await insertIngredient('Butter', {
        state: 'in_stock',
        location: 'fridge',
      });
      const recipeId = await insertRecipe('Dressing', saltId, '5');
      const planId = await insertPlan(0, 6);
      await insertSlot(planId, 1, recipeId);

      const list = await caller().shopping.getForPlan({ planId });
      expect(list.categories).toEqual([]);
      expect(list.staplesToRestock).toEqual([
        expect.objectContaining({
          ingredient: { id: oilId, name: 'Olive Oil' },
          location: 'pantry',
          state: 'running_low',
          neededQuantity: null,
          isChecked: false,
        }),
        expect.objectContaining({
          ingredient: { id: saltId, name: 'Salt' },
          state: 'out',
          neededQuantity: '5.000',
        }),
      ]);
      expect(list.staplesYouHave).toEqual([]);
    });

    it('lists an in-stock Staple the plan needs under the Staples you have', async () => {
      const butterId = await insertIngredient('Butter', {
        state: 'in_stock',
        location: 'fridge',
      });
      const recipeId = await insertRecipe('Toast', butterId, '20');
      const planId = await insertPlan(0, 6);
      await insertSlot(planId, 1, recipeId);

      const list = await caller().shopping.getForPlan({ planId });
      expect(list.categories).toEqual([]);
      expect(list.staplesToRestock).toEqual([]);
      expect(list.staplesYouHave).toEqual([
        expect.objectContaining({
          ingredient: { id: butterId, name: 'Butter' },
          location: 'fridge',
          neededQuantity: '20.000',
        }),
      ]);
    });

    it('leaves Staples the plan doesn’t need off a past plan', async () => {
      await insertIngredient('Olive Oil', {
        state: 'running_low',
        location: 'pantry',
      });
      const planId = await insertPlan(-10, -4);
      const list = await caller().shopping.getForPlan({ planId });
      expect(list.staplesToRestock).toEqual([]);
    });

    it('restocks on a tick and restores the replaced state on an untick', async () => {
      const oilId = await insertIngredient('Olive Oil', {
        state: 'running_low',
        location: 'pantry',
      });
      const planId = await insertPlan(0, 6);

      await caller().shopping.toggleChecked({
        planId,
        ingredientId: oilId,
        isChecked: true,
      });
      expect(await stapleState(oilId)).toBe('in_stock');
      const ticked = await caller().shopping.getForPlan({ planId });
      expect(ticked.staplesToRestock).toEqual([
        expect.objectContaining({ state: 'in_stock', isChecked: true }),
      ]);

      await caller().shopping.toggleChecked({
        planId,
        ingredientId: oilId,
        isChecked: false,
      });
      expect(await stapleState(oilId)).toBe('running_low');
    });

    it('keeps the replaced state when a queued tick replays', async () => {
      const oilId = await insertIngredient('Olive Oil', {
        state: 'out',
        location: 'pantry',
      });
      const planId = await insertPlan(0, 6);
      const tick = { planId, ingredientId: oilId, isChecked: true };
      await caller().shopping.toggleChecked(tick);
      await caller().shopping.toggleChecked(tick);
      await caller().shopping.toggleChecked({ ...tick, isChecked: false });
      expect(await stapleState(oilId)).toBe('out');
    });

    it('drops a restocked Staple from other plans’ lists', async () => {
      const oilId = await insertIngredient('Olive Oil', {
        state: 'running_low',
        location: 'pantry',
      });
      const planA = await insertPlan(0, 6);
      const planB = await insertPlan(7, 13);
      await caller().shopping.toggleChecked({
        planId: planA,
        ingredientId: oilId,
        isChecked: true,
      });
      const listB = await caller().shopping.getForPlan({ planId: planB });
      expect(listB.staplesToRestock).toEqual([]);
    });

    it('never changes a Staple’s state on a quantity reset', async () => {
      const oilId = await insertIngredient('Olive Oil', {
        state: 'running_low',
        location: 'pantry',
      });
      const recipeId = await insertRecipe('Dressing', oilId, '30');
      const planId = await insertPlan(0, 6);
      await insertSlot(planId, 1, recipeId);
      await caller().shopping.toggleChecked({
        planId,
        ingredientId: oilId,
        isChecked: true,
      });

      await db
        .update(recipeIngredients)
        .set({ quantity: '45' })
        .where(eq(recipeIngredients.recipeId, recipeId));
      const list = await caller().shopping.getForPlan({ planId });
      expect(await stapleState(oilId)).toBe('in_stock');
      expect(list.staplesToRestock).toEqual([]);
      expect(list.staplesYouHave).toEqual([
        expect.objectContaining({ isChecked: false, neededQuantity: '45.000' }),
      ]);

      await caller().shopping.toggleChecked({
        planId,
        ingredientId: oilId,
        isChecked: false,
      });
      expect(await stapleState(oilId)).toBe('in_stock');
    });

    it('still refuses a tick on an ingredient that is neither needed nor a Staple', async () => {
      const codId = await insertIngredient('Cod');
      const planId = await insertPlan(0, 6);
      await expectDomainError(
        caller().shopping.toggleChecked({
          planId,
          ingredientId: codId,
          isChecked: true,
        }),
        'SHOPPING_INGREDIENT_NOT_IN_PLAN',
      );
    });
  });

  describe('marking a Staple', () => {
    it('asks before deleting the stock of a held ingredient, then deletes it', async () => {
      const { codId, planId, freezerId } = await codScenario();
      await insertStock(codId, 'fridge', '100');
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });

      const error = await expectDomainError(
        caller().ingredients.update({
          id: codId,
          patch: { stapleLocation: 'freezer' },
        }),
        'INGREDIENT_STAPLE_HAS_STOCK',
      );
      expect(error.cause).toMatchObject({ stockItems: 2, reservations: 2 });
      expect(await stockQuantity(freezerId)).toBe('500.000');

      const updated = await caller().ingredients.update({
        id: codId,
        patch: { stapleLocation: 'freezer' },
        deleteStock: true,
      });
      expect(updated).toMatchObject({
        stapleLocation: 'freezer',
        stapleState: 'in_stock',
      });
      expect(await stockQuantity(freezerId)).toBeUndefined();
      expect(await lineReservations(planId, codId)).toEqual([]);
    });

    it('keeps the state when a Staple moves, and clears both when unmarked', async () => {
      const oilId = await insertIngredient('Olive Oil', {
        state: 'out',
        location: 'pantry',
      });
      expect(
        await caller().ingredients.update({
          id: oilId,
          patch: { stapleLocation: 'fridge' },
        }),
      ).toMatchObject({ stapleLocation: 'fridge', stapleState: 'out' });
      expect(
        await caller().ingredients.update({
          id: oilId,
          patch: { stapleLocation: null },
        }),
      ).toMatchObject({ stapleLocation: null, stapleState: null });
    });

    it('creates an ingredient as a Staple, in stock', async () => {
      const created = await caller().ingredients.create({
        name: 'Rice',
        categoryId,
        defaultUnitId: gramsId,
        isPlant: true,
        averageShelfLifeDays: null,
        stapleLocation: 'pantry',
      });
      expect(created).toMatchObject({
        stapleLocation: 'pantry',
        stapleState: 'in_stock',
      });
    });

    it('sets a Staple’s state, and refuses an ingredient that isn’t one', async () => {
      const oilId = await insertIngredient('Olive Oil', {
        state: 'in_stock',
        location: 'pantry',
      });
      expect(
        await caller().ingredients.setStapleState({
          id: oilId,
          state: 'running_low',
        }),
      ).toMatchObject({ stapleState: 'running_low' });

      const codId = await insertIngredient('Cod');
      await expectDomainError(
        caller().ingredients.setStapleState({ id: codId, state: 'out' }),
        'INGREDIENT_NOT_STAPLE',
      );
    });

    it('refuses a Stock item of a Staple, and lists Staples by location', async () => {
      const oilId = await insertIngredient('Olive Oil', {
        state: 'running_low',
        location: 'pantry',
      });
      await expectDomainError(
        caller().storage.create({
          location: 'pantry',
          target: { kind: 'ingredient', ingredientId: oilId },
          quantity: '500',
          addedOn: iso(0),
        }),
        'STOCK_INGREDIENT_IS_STAPLE',
      );
      const storage = await caller().storage.list();
      expect(storage.staples).toEqual([
        {
          ingredientId: oilId,
          name: 'Olive Oil',
          location: 'pantry',
          state: 'running_low',
        },
      ]);
    });
  });

  describe('the glance', () => {
    it('shows until dismissed, per plan', async () => {
      const planA = await insertPlan(0, 6);
      const planB = await insertPlan(7, 13);
      expect(
        (await caller().shopping.getForPlan({ planId: planA }))
          .showStorageGlance,
      ).toBe(true);

      await caller().shopping.dismissStorageGlance({ planId: planA });
      expect(
        (await caller().shopping.getForPlan({ planId: planA }))
          .showStorageGlance,
      ).toBe(false);
      expect(
        (await caller().shopping.getForPlan({ planId: planB }))
          .showStorageGlance,
      ).toBe(true);
    });
  });

  describe('deleting a plan', () => {
    it('asks first when the plan has food set aside, then frees it', async () => {
      const { codId, planId, freezerId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });

      const error = await expectDomainError(
        caller().plans.delete({ id: planId }),
        'PLAN_HAS_RESERVATIONS',
      );
      expect(error.cause).toMatchObject({ reservations: 1, stockItems: 1 });
      expect(await lineReservations(planId, codId)).toHaveLength(1);

      await caller().plans.delete({ id: planId, releaseReservations: true });
      expect(await lineReservations(planId, codId)).toEqual([]);
      expect(await stockQuantity(freezerId)).toBe('500.000');
    });

    it('doesn’t ask about food already eaten, and leaves it eaten', async () => {
      const codId = await insertIngredient('Cod');
      const recipeId = await insertRecipe('Fish Pie', codId, '400');
      const planId = await insertPlan(-3, -1);
      await insertSlot(planId, -2, recipeId);
      const freezerId = await insertStock(codId, 'freezer', '500');
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });

      await caller().plans.delete({ id: planId });
      expect(await stockQuantity(freezerId)).toBe('100.000');
    });
  });

  describe('lock order', () => {
    // Holds a transaction open after `first` runs, until `release` is called.
    function holdOpen(first: (tx: Tx) => Promise<void>) {
      const withTransaction = makeWithTransaction(db);
      let release!: (then: (tx: Tx) => Promise<void>) => void;
      const released = new Promise<(tx: Tx) => Promise<void>>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const isReady = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const done = withTransaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '3s'`);
        await first(tx);
        ready();
        const then = await released;
        await then(tx);
      });
      return { isReady, release, done };
    }

    const pause = () => new Promise((resolve) => setTimeout(resolve, 300));

    it('reserving waits on a Stock item before touching its Reservations, like a Storage edit', async () => {
      const { codId, planId, freezerId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });

      // A Storage edit: lock the item, then release its Reservations.
      const edit = holdOpen(async (tx) => {
        await tx.execute(
          sql`select id from stock_items where id = ${freezerId} for update`,
        );
      });
      await edit.isReady;
      const reserving = caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'amount', amount: '100' },
      });
      await pause();
      edit.release(async (tx) => {
        await tx.execute(
          sql`delete from stock_reservations where stock_item_id = ${freezerId}`,
        );
      });

      await edit.done;
      expect((await reserving).reserved).toBe('100.000');
      expect(await lineReservations(planId, codId)).toEqual([
        expect.objectContaining({ amount: '100.000' }),
      ]);
    });

    it('reserving waits on a plan being deleted, so the delete can’t miss its Reservation', async () => {
      const { codId, planId } = await codScenario();
      await caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'all' },
      });

      // `plans.delete` locks the plan, then cascades to its Reservations.
      const deleting = holdOpen(async (tx) => {
        await tx.execute(
          sql`select id from meal_plans where id = ${planId} for update`,
        );
      });
      await deleting.isReady;
      const reserving = caller().shopping.setLineReservations({
        planId,
        ingredientId: codId,
        choice: { kind: 'amount', amount: '100' },
      });
      await pause();
      deleting.release(async (tx) => {
        await tx.execute(sql`delete from meal_plans where id = ${planId}`);
      });

      await deleting.done;
      await expect(reserving).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await lineReservations(planId, codId)).toEqual([]);
    });
  });
});
