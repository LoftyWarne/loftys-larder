import { TRPCError } from '@trpc/server';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  ApplyPlanSlot,
  SlotItemInput,
  UpdateSlotInput,
} from '../../shared/src/index.ts';
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
import { recipeIngredients, recipes } from '../src/db/schema/recipes.ts';
import {
  ingredientCategories,
  mealOccasions,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { stockItems, stockReservations } from '../src/db/schema/storage.ts';
import {
  addDays,
  eachDateInRange,
  formatCivilDate,
  todayInLondon,
} from '../src/lib/date-utils.ts';
import { makeWithTransaction, type Tx } from '../src/db/withTransaction.ts';
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

const USER_ID = 'user-slot-reservations-test-1';
const USER_EMAIL = 'slot-reservations@example.com';

async function expectDomainError(
  promise: Promise<unknown>,
  trpcCode: TRPCError['code'],
  domainCode: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TRPCError);
    const trpcError = error as TRPCError;
    expect(trpcError.code).toBe(trpcCode);
    const cause = trpcError.cause as unknown as Record<string, unknown>;
    expect(cause.code).toBe(domainCode);
    return;
  }
  throw new Error(`expected ${domainCode}`);
}

describe('eating from storage in the planner', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let lunchId!: number;
  let dinnerId!: number;
  let lasagneId!: number;
  let stewBaseId!: number;
  let stewVariationId!: number;
  let planId!: number;
  const today = todayInLondon();
  const tomorrow = addDays(today, 1);

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
        ${mealPlanSlots},
        ${mealPlans},
        ${recipeIngredients},
        ${recipes},
        ${ingredients},
        ${ingredientCategories},
        ${unitsOfMeasurement},
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
      name: 'Reservations Tester',
      emailVerified: true,
    });
    const occasions = await db
      .insert(mealOccasions)
      .values([{ name: 'Lunch' }, { name: 'Dinner' }])
      .returning({ id: mealOccasions.id });
    lunchId = occasions[0]?.id ?? 0;
    dinnerId = occasions[1]?.id ?? 0;
    lasagneId = await insertRecipe('Lasagne');
    stewBaseId = await insertRecipe('Beef Stew Base', { isBase: true });
    stewVariationId = await insertRecipe('Stew Pie', {
      baseRecipeId: stewBaseId,
    });
    planId = await insertPlan(addDays(today, -3));
  });

  function makeContext(): AppContext {
    return {
      req: {} as AppContext['req'],
      reply: {} as AppContext['reply'],
      reqId: 'rid-test',
      ...contextDeps(),
      db,
      cloudinary: {
        cloudName: 'test-cloud',
        apiKey: 'test-key',
        apiSecret: 'test-secret',
      },
      session: {
        id: 'session-slot-reservations-1',
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
        name: 'Reservations Tester',
        emailVerified: true,
        image: null,
        themePreference: 'system',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
  }

  const caller = (): ReturnType<typeof appRouter.createCaller> =>
    appRouter.createCaller(makeContext());

  async function insertRecipe(
    name: string,
    options: { isBase?: boolean; baseRecipeId?: number } = {},
  ): Promise<number> {
    const [row] = await db
      .insert(recipes)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name,
        baseServings: 4,
        addedByUserId: USER_ID,
        isBase: options.isBase ?? false,
        baseRecipeId: options.baseRecipeId ?? null,
      })
      .returning({ id: recipes.id });
    if (!row) throw new Error('recipe insert failed');
    return row.id;
  }

  async function insertPlan(start: Date, days = 7): Promise<number> {
    const [row] = await db
      .insert(mealPlans)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        createdByUserId: USER_ID,
        startDate: start,
        endDate: addDays(start, days - 1),
      })
      .returning({ id: mealPlans.id });
    if (!row) throw new Error('plan insert failed');
    return row.id;
  }

  async function emptySlot(
    date: Date,
    occasionId: number = dinnerId,
    plan: number = planId,
  ): Promise<number> {
    const [slot] = await db
      .insert(mealPlanSlots)
      .values({ planId: plan, date, occasionId, slotType: 'empty' })
      .returning({ id: mealPlanSlots.id });
    if (!slot) throw new Error('slot insert failed');
    return slot.id;
  }

  async function stock(
    recipeId: number,
    quantity: string,
    options: {
      location?: 'freezer' | 'fridge' | 'pantry';
      addedOn?: Date;
      useBy?: Date | null;
    } = {},
  ): Promise<number> {
    const location = options.location ?? 'freezer';
    const [row] = await db
      .insert(stockItems)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        location,
        recipeId,
        quantity,
        addedOn: options.addedOn ?? addDays(today, -10),
        useBy:
          location === 'fridge' ? (options.useBy ?? addDays(today, 3)) : null,
      })
      .returning({ id: stockItems.id });
    if (!row) throw new Error('stock insert failed');
    return row.id;
  }

  function fromStorage(
    slotId: number,
    recipeId: number,
    eaten: number,
    extra: Partial<SlotItemInput> = {},
  ): UpdateSlotInput {
    return {
      slotId,
      slotType: 'leftovers',
      leftoversSource: 'storage',
      chefUserId: null,
      comment: null,
      items: [
        {
          recipeId,
          prepared: 0,
          eaten,
          fromStorage: eaten,
          sortOrder: 0,
          ...extra,
        },
      ],
      dinerUserIds: [],
      guestCount: eaten,
    };
  }

  function cookingVariation(
    slotId: number,
    prepared: number,
    useHeldBase: boolean,
  ): UpdateSlotInput {
    return {
      slotId,
      slotType: 'recipe',
      leftoversSource: null,
      chefUserId: null,
      comment: null,
      items: [
        {
          recipeId: stewVariationId,
          prepared,
          eaten: prepared,
          ...(useHeldBase && { fromStorage: prepared }),
          sortOrder: 0,
        },
      ],
      dinerUserIds: [],
      guestCount: prepared,
    };
  }

  async function reservations() {
    return db
      .select({
        stockItemId: stockReservations.stockItemId,
        slotItemId: stockReservations.slotItemId,
        amount: stockReservations.amount,
        neededOn: stockReservations.neededOn,
      })
      .from(stockReservations)
      .orderBy(asc(stockReservations.stockItemId), asc(stockReservations.id));
  }

  async function quantityOf(stockItemId: number): Promise<string | null> {
    const [row] = await db
      .select({ quantity: stockItems.quantity })
      .from(stockItems)
      .where(eq(stockItems.id, stockItemId));
    return row?.quantity ?? null;
  }

  describe('Leftovers from Storage', () => {
    it('reserves the eaten portions for the slot’s day', async () => {
      const lasagne = await stock(lasagneId, '2');
      const slotId = await emptySlot(tomorrow);
      const { slot } = await caller().slots.update(
        fromStorage(slotId, lasagneId, 2),
      );

      expect(slot.leftoversSource).toBe('storage');
      expect(slot.items[0]).toMatchObject({
        recipeId: lasagneId,
        prepared: 0,
        eaten: 2,
        fromStorage: 2,
        reserved: 2,
        storageLocations: ['freezer'],
      });
      const [held] = await reservations();
      expect(held).toMatchObject({
        stockItemId: lasagne,
        slotItemId: slot.items[0]?.id,
        amount: '2.000',
      });
      expect(formatCivilDate(held?.neededOn ?? today)).toBe(
        formatCivilDate(tomorrow),
      );
    });

    it('reserves what’s held when it isn’t enough', async () => {
      await stock(lasagneId, '1');
      const slotId = await emptySlot(tomorrow);
      const { slot } = await caller().slots.update(
        fromStorage(slotId, lasagneId, 3),
      );
      expect(slot.items[0]).toMatchObject({ fromStorage: 3, reserved: 1 });
    });

    it('draws only from the picker entry chosen, past Use-by or not', async () => {
      await stock(lasagneId, '4');
      const oldFridge = await stock(lasagneId, '2', {
        location: 'fridge',
        useBy: addDays(today, -1),
      });
      const slotId = await emptySlot(tomorrow);
      await caller().slots.update(
        fromStorage(slotId, lasagneId, 2, { stockItemIds: [oldFridge] }),
      );
      expect(await reservations()).toMatchObject([
        { stockItemId: oldFridge, amount: '2.000' },
      ]);
    });

    it('skips past-Use-by Fridge food when no entry is named', async () => {
      await stock(lasagneId, '2', {
        location: 'fridge',
        useBy: addDays(today, -1),
      });
      const freezer = await stock(lasagneId, '2');
      const slotId = await emptySlot(tomorrow);
      await caller().slots.update(fromStorage(slotId, lasagneId, 2));
      expect(await reservations()).toMatchObject([
        { stockItemId: freezer, amount: '2.000' },
      ]);
    });

    it('offers a soft-deleted recipe’s Stock item', async () => {
      await stock(lasagneId, '2');
      await db
        .update(recipes)
        .set({ isDeleted: true })
        .where(eq(recipes.id, lasagneId));
      const slotId = await emptySlot(tomorrow);
      const { slot } = await caller().slots.update(
        fromStorage(slotId, lasagneId, 2),
      );
      expect(slot.items[0]).toMatchObject({ isDeleted: true, reserved: 2 });
    });

    it('lowers and raises the Reservation with the portions', async () => {
      const lasagne = await stock(lasagneId, '4');
      const slotId = await emptySlot(tomorrow);
      await caller().slots.update(fromStorage(slotId, lasagneId, 3));
      await caller().slots.update(fromStorage(slotId, lasagneId, 1));
      expect(await reservations()).toMatchObject([
        { stockItemId: lasagne, amount: '1.000' },
      ]);
      await caller().slots.update(fromStorage(slotId, lasagneId, 4));
      expect(await reservations()).toMatchObject([
        { stockItemId: lasagne, amount: '4.000' },
      ]);
    });

    it('releases the Reservation when the slot type or dish changes', async () => {
      const otherId = await insertRecipe('Fish Pie');
      await stock(lasagneId, '2');
      const fishPie = await stock(otherId, '2');
      const slotId = await emptySlot(tomorrow);
      await caller().slots.update(fromStorage(slotId, lasagneId, 2));

      await caller().slots.update(fromStorage(slotId, otherId, 2));
      expect(await reservations()).toMatchObject([
        { stockItemId: fishPie, amount: '2.000' },
      ]);

      await caller().slots.update({
        ...fromStorage(slotId, otherId, 2),
        slotType: 'eat_out',
        leftoversSource: null,
        items: [],
      });
      expect(await reservations()).toEqual([]);
    });

    it('never reserves for a slot whose day has passed', async () => {
      await stock(lasagneId, '2');
      const slotId = await emptySlot(addDays(today, -1));
      const { slot } = await caller().slots.update(
        fromStorage(slotId, lasagneId, 2),
      );
      expect(slot.items[0]).toMatchObject({ fromStorage: 2, reserved: 0 });
      expect(await reservations()).toEqual([]);
    });
  });

  describe('a frozen base for a Variation', () => {
    it('reserves the Variation’s prepared base portions when chosen', async () => {
      const base = await stock(stewBaseId, '2');
      const slotId = await emptySlot(tomorrow);
      const { slot } = await caller().slots.update(
        cookingVariation(slotId, 2, true),
      );
      expect(slot.items[0]).toMatchObject({ fromStorage: 2, reserved: 2 });
      expect(await reservations()).toMatchObject([
        { stockItemId: base, amount: '2.000' },
      ]);
    });

    it('is never automatic, and releases when turned off', async () => {
      await stock(stewBaseId, '2');
      const slotId = await emptySlot(tomorrow);
      await caller().slots.update(cookingVariation(slotId, 2, false));
      expect(await reservations()).toEqual([]);

      await caller().slots.update(cookingVariation(slotId, 2, true));
      expect(await reservations()).toHaveLength(1);
      await caller().slots.update(cookingVariation(slotId, 2, false));
      expect(await reservations()).toEqual([]);
    });

    it('takes a base only from the Freezer or Fridge', async () => {
      await stock(stewBaseId, '2', { location: 'pantry' });
      const slotId = await emptySlot(tomorrow);
      const { slot } = await caller().slots.update(
        cookingVariation(slotId, 2, true),
      );
      expect(slot.items[0]?.reserved).toBe(0);
    });

    it('refuses storage for a cooked dish that isn’t a Variation', async () => {
      const slotId = await emptySlot(tomorrow);
      await expectDomainError(
        caller().slots.update({
          ...cookingVariation(slotId, 2, true),
          items: [
            {
              recipeId: lasagneId,
              prepared: 2,
              eaten: 2,
              fromStorage: 2,
              sortOrder: 0,
            },
          ],
        }),
        'BAD_REQUEST',
        'SLOT_FROM_STORAGE_NOT_VARIATION',
      );
    });
  });

  describe('drags', () => {
    it('moves the Reservation’s day with the slot, earlier or later', async () => {
      await stock(lasagneId, '2');
      const source = await emptySlot(addDays(today, 3));
      const earlier = await emptySlot(tomorrow);
      await caller().slots.update(fromStorage(source, lasagneId, 2));

      await caller().slots.relocate({
        sourceSlotId: source,
        destSlotId: earlier,
      });
      const [held] = await reservations();
      expect(formatCivilDate(held?.neededOn ?? today)).toBe(
        formatCivilDate(tomorrow),
      );
    });

    it('swaps two slots’ Reservations with their dishes', async () => {
      await stock(lasagneId, '2');
      await stock(stewBaseId, '2');
      const first = await emptySlot(tomorrow);
      const second = await emptySlot(addDays(today, 2));
      await caller().slots.update(fromStorage(first, lasagneId, 2));
      await caller().slots.update(cookingVariation(second, 2, true));

      await caller().slots.relocate({
        sourceSlotId: first,
        destSlotId: second,
      });
      const rows = await db
        .select({
          recipeId: stockItems.recipeId,
          neededOn: stockReservations.neededOn,
        })
        .from(stockReservations)
        .innerJoin(
          stockItems,
          eq(stockItems.id, stockReservations.stockItemId),
        );
      const byRecipe = new Map(
        rows.map((row) => [row.recipeId, formatCivilDate(row.neededOn)]),
      );
      expect(byRecipe.get(lasagneId)).toBe(formatCivilDate(addDays(today, 2)));
      expect(byRecipe.get(stewBaseId)).toBe(formatCivilDate(tomorrow));
    });

    it('moves a passed slot only once its Reservation has settled', async () => {
      const lasagne = await stock(lasagneId, '2');
      const passed = await emptySlot(addDays(today, -1));
      const later = await emptySlot(addDays(today, 2));
      const [item] = await db
        .update(mealPlanSlots)
        .set({ slotType: 'leftovers', leftoversSource: 'storage' })
        .where(eq(mealPlanSlots.id, passed))
        .returning({ id: mealPlanSlots.id });
      const [dish] = await db
        .insert(mealPlanSlotItems)
        .values({
          slotId: item?.id ?? 0,
          recipeId: lasagneId,
          prepared: 0,
          eaten: 2,
          fromStorage: 2,
          sortOrder: 0,
        })
        .returning({ id: mealPlanSlotItems.id });
      await db.insert(stockReservations).values({
        householdId: CURRENT_HOUSEHOLD_ID,
        stockItemId: lasagne,
        planId,
        slotItemId: dish?.id ?? 0,
        amount: '2',
        neededOn: addDays(today, -1),
      });

      await caller().slots.relocate({
        sourceSlotId: passed,
        destSlotId: later,
      });
      expect(await reservations()).toEqual([]);
      expect(await quantityOf(lasagne)).toBeNull();
    });
  });

  describe('when it leaves storage', () => {
    it('settles a passed day’s Reservation on the next planner read', async () => {
      const lasagne = await stock(lasagneId, '3');
      const slotId = await emptySlot(tomorrow);
      await caller().slots.update(fromStorage(slotId, lasagneId, 2));
      await db.update(stockReservations).set({ neededOn: addDays(today, -1) });

      const plan = await caller().plans.get({ id: planId });
      expect(await reservations()).toEqual([]);
      expect(await quantityOf(lasagne)).toBe('1.000');
      const dish = plan.slots.find((slot) => slot.id === slotId)?.items[0];
      expect(dish).toMatchObject({ fromStorage: 2, reserved: 0 });
    });
  });

  describe('deleting a plan', () => {
    it('warns about the slot’s Reservations, releases them, and keeps settled food used', async () => {
      const lasagne = await stock(lasagneId, '4');
      const base = await stock(stewBaseId, '2');
      const eaten = await emptySlot(addDays(today, -1), lunchId);
      const later = await emptySlot(tomorrow);
      const variation = await emptySlot(addDays(today, 2));
      await caller().slots.update(fromStorage(later, lasagneId, 2));
      await caller().slots.update(cookingVariation(variation, 2, true));
      // A Reservation for a passed day, as if it was made before then.
      await db.insert(stockReservations).values({
        householdId: CURRENT_HOUSEHOLD_ID,
        stockItemId: lasagne,
        planId,
        slotItemId: (
          await db
            .insert(mealPlanSlotItems)
            .values({
              slotId: eaten,
              recipeId: lasagneId,
              prepared: 0,
              eaten: 1,
              fromStorage: 1,
              sortOrder: 0,
            })
            .returning({ id: mealPlanSlotItems.id })
        )[0]?.id,
        amount: '1',
        neededOn: addDays(today, -1),
      });

      try {
        await caller().plans.delete({ id: planId });
        throw new Error('expected PLAN_HAS_RESERVATIONS');
      } catch (error) {
        const cause = (error as TRPCError).cause as unknown as Record<
          string,
          unknown
        >;
        expect(cause).toMatchObject({
          code: 'PLAN_HAS_RESERVATIONS',
          reservations: 2,
          stockItems: 2,
        });
      }

      await caller().plans.delete({ id: planId, releaseReservations: true });
      expect(await reservations()).toEqual([]);
      // The passed day's portion stays eaten; the rest is free again.
      expect(await quantityOf(lasagne)).toBe('3.000');
      expect(await quantityOf(base)).toBe('2.000');
    });
  });

  describe('Apply', () => {
    it('writes storage slots and their Reservations in one go', async () => {
      const lasagne = await stock(lasagneId, '2');
      const base = await stock(stewBaseId, '2');
      const start = addDays(today, 10);
      const dates = eachDateInRange(start, addDays(start, 1)).map(
        formatCivilDate,
      );
      const slots: ApplyPlanSlot[] = dates.flatMap((date) =>
        [lunchId, dinnerId].map(
          (occasionId): ApplyPlanSlot => ({
            date,
            occasionId,
            slotType: 'empty',
            leftoversSource: null,
            items: [],
            dinerUserIds: [],
            guestCount: 2,
          }),
        ),
      );
      const [first, second] = slots;
      if (!first || !second) throw new Error('slots missing');
      Object.assign(first, {
        slotType: 'leftovers',
        leftoversSource: 'storage',
        items: [
          {
            recipeId: lasagneId,
            prepared: 0,
            eaten: 2,
            fromStorage: 2,
            sortOrder: 0,
          },
        ],
      });
      Object.assign(second, {
        slotType: 'recipe',
        items: [
          {
            recipeId: stewVariationId,
            prepared: 2,
            eaten: 2,
            fromStorage: 2,
            sortOrder: 0,
          },
        ],
      });

      const { plan } = await caller().plans.createWithSlots({
        startDate: dates[0] ?? '',
        endDate: dates[1] ?? '',
        slots,
        reviewCounts: null,
      });
      const held = await db
        .select({
          stockItemId: stockReservations.stockItemId,
          amount: stockReservations.amount,
        })
        .from(stockReservations)
        .where(eq(stockReservations.planId, plan.id))
        .orderBy(asc(stockReservations.stockItemId));
      expect(held).toEqual([
        { stockItemId: lasagne, amount: '2.000' },
        { stockItemId: base, amount: '2.000' },
      ]);
    });
  });

  describe('duplicating a plan', () => {
    it('copies a storage dish and reserves what’s held now', async () => {
      const lasagne = await stock(lasagneId, '4');
      const slotId = await emptySlot(tomorrow);
      await caller().slots.update(fromStorage(slotId, lasagneId, 2));

      const { plan } = await caller().plans.duplicate({
        planId,
        newStartDate: formatCivilDate(addDays(today, 20)),
      });
      const held = await db
        .select({
          stockItemId: stockReservations.stockItemId,
          amount: stockReservations.amount,
        })
        .from(stockReservations)
        .where(
          and(
            eq(stockReservations.planId, plan.id),
            eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
          ),
        );
      expect(held).toEqual([{ stockItemId: lasagne, amount: '2.000' }]);
    });
  });

  describe('when the Stock item goes from storage', () => {
    it('releases the slot’s Reservation, keeps the storage slot and shows nothing held', async () => {
      const lasagne = await stock(lasagneId, '2');
      const slotId = await emptySlot(tomorrow);
      await caller().slots.update(fromStorage(slotId, lasagneId, 2));

      await expectDomainError(
        caller().storage.delete({ id: lasagne }),
        'CONFLICT',
        'STOCK_RESERVED',
      );
      await caller().storage.delete({ id: lasagne, releaseReservations: true });

      expect(await reservations()).toEqual([]);
      const plan = await caller().plans.get({ id: planId });
      const slot = plan.slots.find((candidate) => candidate.id === slotId);
      expect(slot?.leftoversSource).toBe('storage');
      expect(slot?.items[0]).toMatchObject({
        fromStorage: 2,
        reserved: 0,
        storageLocations: [],
      });
    });
  });

  describe('the shopping list', () => {
    it('buys only a Variation’s own ingredients when it uses a frozen base, and nothing for a dish eaten from storage', async () => {
      const [category] = await db
        .insert(ingredientCategories)
        .values({ name: 'Meat' })
        .returning({ id: ingredientCategories.id });
      const [unit] = await db
        .insert(unitsOfMeasurement)
        .values({ name: 'g' })
        .returning({ id: unitsOfMeasurement.id });
      const [steak, pastry, mince] = await db
        .insert(ingredients)
        .values(
          ['Braising Steak', 'Puff Pastry', 'Beef Mince'].map((name) => ({
            householdId: CURRENT_HOUSEHOLD_ID,
            name,
            categoryId: category?.id ?? 0,
            defaultUnitId: unit?.id ?? 0,
          })),
        )
        .returning({ id: ingredients.id });
      await db.insert(recipeIngredients).values([
        { recipeId: stewBaseId, ingredientId: steak?.id ?? 0, quantity: '800' },
        {
          recipeId: stewVariationId,
          ingredientId: pastry?.id ?? 0,
          quantity: '320',
        },
        { recipeId: lasagneId, ingredientId: mince?.id ?? 0, quantity: '500' },
      ]);
      await stock(stewBaseId, '2');
      await stock(lasagneId, '2');
      await caller().slots.update(
        cookingVariation(await emptySlot(tomorrow), 2, true),
      );
      await caller().slots.update(
        fromStorage(await emptySlot(tomorrow, lunchId), lasagneId, 2),
      );

      const list = await caller().shopping.getForPlan({ planId });
      const names = list.categories.flatMap((group) =>
        group.lines.map((line) => line.ingredient.name),
      );
      expect(names).toEqual(['Puff Pastry']);
    });
  });

  describe('duplicating a plan whose Variation has lost its base', () => {
    it('copies the dish as cooked from scratch', async () => {
      await stock(stewBaseId, '4');
      const slotId = await emptySlot(tomorrow);
      await caller().slots.update(cookingVariation(slotId, 2, true));
      await db
        .update(recipes)
        .set({ baseRecipeId: null })
        .where(eq(recipes.id, stewVariationId));

      const { plan } = await caller().plans.duplicate({
        planId,
        newStartDate: formatCivilDate(addDays(today, 20)),
      });
      const copied = await caller().plans.get({ id: plan.id });
      const dish = copied.slots.flatMap((slot) => slot.items)[0];
      expect(dish).toMatchObject({ recipeId: stewVariationId, fromStorage: 0 });
      const held = await db
        .select({ id: stockReservations.id })
        .from(stockReservations)
        .where(eq(stockReservations.planId, plan.id));
      expect(held).toEqual([]);
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

    it('a slot save waits on a Stock item before touching its Reservations, like a Storage edit', async () => {
      const lasagne = await stock(lasagneId, '4');
      const slotId = await emptySlot(tomorrow);
      await caller().slots.update(fromStorage(slotId, lasagneId, 2));

      const edit = holdOpen(async (tx) => {
        await tx.execute(
          sql`select id from stock_items where id = ${lasagne} for update`,
        );
      });
      await edit.isReady;
      const saving = caller().slots.update(fromStorage(slotId, lasagneId, 3));
      await pause();
      edit.release(async (tx) => {
        await tx.execute(
          sql`delete from stock_reservations where stock_item_id = ${lasagne}`,
        );
      });

      await edit.done;
      expect((await saving).slot.items[0]?.reserved).toBe(3);
      expect(await reservations()).toMatchObject([
        { stockItemId: lasagne, amount: '3.000' },
      ]);
    });

    it('a slot save waits on a plan being deleted, so the delete can’t miss its Reservation', async () => {
      await stock(lasagneId, '2');
      const slotId = await emptySlot(tomorrow);

      const deleting = holdOpen(async (tx) => {
        await tx.execute(
          sql`select id from meal_plans where id = ${planId} for update`,
        );
      });
      await deleting.isReady;
      const saving = caller().slots.update(fromStorage(slotId, lasagneId, 2));
      await pause();
      deleting.release(async (tx) => {
        await tx.execute(sql`delete from meal_plans where id = ${planId}`);
      });

      await deleting.done;
      await expect(saving).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await reservations()).toEqual([]);
    });
  });
});
