import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
import { mealPlans } from '../src/db/schema/meal-plans.ts';
import {
  ingredientCategories,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { recipes } from '../src/db/schema/recipes.ts';
import { stockItems, stockReservations } from '../src/db/schema/storage.ts';
import { makeWithTransaction } from '../src/db/withTransaction.ts';
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

const USER_ID = 'user-storage-test-1';
const USER_EMAIL = 'storage@example.com';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009ab';

async function expectDomainError(
  promise: Promise<unknown>,
  trpcCode: TRPCError['code'],
  domainCode: string,
): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TRPCError);
    const trpcError = error as TRPCError;
    expect(trpcError.code).toBe(trpcCode);
    const cause = trpcError.cause as unknown as Record<string, unknown>;
    expect(cause.code).toBe(domainCode);
    return cause;
  }
  throw new Error(`expected ${domainCode}`);
}

describe('storage procedures', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let gramsUnitId!: number;
  let piecesUnitId!: number;
  let categoryId!: number;
  let codId!: number;
  let chickenId!: number;
  let lemonId!: number;
  let stewId!: number;
  let planId!: number;
  const today = todayInLondon();
  const todayIso = formatCivilDate(today);
  const iso = (days: number): string => formatCivilDate(addDays(today, days));

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
        ${mealPlans},
        ${recipes},
        ${ingredients},
        ${ingredientCategories},
        ${unitsOfMeasurement},
        ${households},
        ${users},
        ${sessions},
        ${accounts},
        ${verifications}
      restart identity cascade
    `);
    await db.insert(households).values([
      { id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" },
      { id: OTHER_HOUSEHOLD_ID, name: 'Other Household' },
    ]);
    await db.insert(users).values({
      id: USER_ID,
      email: USER_EMAIL,
      name: 'Storage Tester',
      emailVerified: true,
    });
    const [category] = await db
      .insert(ingredientCategories)
      .values({ name: 'Fish' })
      .returning();
    const units = await db
      .insert(unitsOfMeasurement)
      .values([{ name: 'g' }, { name: 'piece' }])
      .returning();
    if (!category || !units[0] || !units[1]) throw new Error('seed failed');
    categoryId = category.id;
    gramsUnitId = units[0].id;
    piecesUnitId = units[1].id;

    codId = await insertIngredient('Cod', null);
    chickenId = await insertIngredient('Chicken Thigh', 2);
    lemonId = await insertIngredient('Lemon', null, piecesUnitId);
    stewId = await insertRecipe('Beef Stew Base', { isBase: true });

    const [plan] = await db
      .insert(mealPlans)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        startDate: today,
        endDate: addDays(today, 6),
      })
      .returning({ id: mealPlans.id });
    planId = plan?.id ?? 0;
  });

  async function insertIngredient(
    name: string,
    averageShelfLifeDays: number | null,
    unitId: number = gramsUnitId,
    householdId: string = CURRENT_HOUSEHOLD_ID,
  ): Promise<number> {
    const [row] = await db
      .insert(ingredients)
      .values({
        householdId,
        name,
        categoryId,
        defaultUnitId: unitId,
        averageShelfLifeDays,
      })
      .returning({ id: ingredients.id });
    if (!row) throw new Error('ingredient insert failed');
    return row.id;
  }

  async function insertRecipe(
    name: string,
    options: {
      isBase?: boolean;
      isDeleted?: boolean;
      householdId?: string;
    } = {},
  ): Promise<number> {
    const [row] = await db
      .insert(recipes)
      .values({
        householdId: options.householdId ?? CURRENT_HOUSEHOLD_ID,
        name,
        baseServings: 4,
        isBase: options.isBase ?? false,
        isDeleted: options.isDeleted ?? false,
        addedByUserId: USER_ID,
      })
      .returning({ id: recipes.id });
    if (!row) throw new Error('recipe insert failed');
    return row.id;
  }

  async function reserve(
    stockItemId: number,
    amount: string,
    neededOn: Date,
  ): Promise<void> {
    await db.insert(stockReservations).values({
      householdId: CURRENT_HOUSEHOLD_ID,
      stockItemId,
      planId,
      ingredientId: codId,
      amount,
      neededOn,
    });
  }

  function makeContext(): AppContext {
    return {
      req: {} as AppContext['req'],
      reply: {} as AppContext['reply'],
      reqId: 'rid-test',
      ...contextDeps(),
      db,
      cloudinary: { cloudName: 'c', apiKey: 'k', apiSecret: 's' },
      session: {
        id: 'session-storage-1',
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
        name: 'Storage Tester',
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

  async function addCod(
    quantity = '500',
    location: 'freezer' | 'fridge' | 'pantry' = 'freezer',
  ): Promise<number> {
    const { id } = await caller().storage.create({
      location,
      target: { kind: 'ingredient', ingredientId: codId },
      quantity,
      addedOn: todayIso,
    });
    return id;
  }

  async function itemById(id: number) {
    const { items } = await caller().storage.list();
    return items.find((item) => item.id === id);
  }

  describe('create and list', () => {
    it('lists an ingredient and a dish with their names, units and reserved amounts', async () => {
      const cod = await addCod();
      await reserve(cod, '200', addDays(today, 2));
      await caller().storage.create({
        location: 'freezer',
        target: { kind: 'recipe', recipeId: stewId },
        quantity: '2',
        addedOn: iso(-42),
      });

      const { today: listedToday, items } = await caller().storage.list();
      expect(listedToday).toBe(todayIso);
      expect(items).toHaveLength(2);
      const [stew, codItem] = items;
      expect(stew).toMatchObject({
        location: 'freezer',
        quantity: '2.000',
        reserved: '0.000',
        addedOn: iso(-42),
        useBy: null,
        target: {
          kind: 'recipe',
          recipeId: stewId,
          name: 'Beef Stew Base',
          isBase: true,
          isDeleted: false,
        },
      });
      expect(codItem).toMatchObject({
        quantity: '500.000',
        reserved: '200.000',
        target: { kind: 'ingredient', name: 'Cod', unitName: 'g' },
      });
    });

    it('never merges items of the same ingredient', async () => {
      await addCod('500');
      await addCod('300');
      const { items } = await caller().storage.list();
      expect(items).toHaveLength(2);
    });

    it('refuses an added date after today', async () => {
      await expectDomainError(
        caller().storage.create({
          location: 'pantry',
          target: { kind: 'ingredient', ingredientId: codId },
          quantity: '1',
          addedOn: iso(1),
        }),
        'BAD_REQUEST',
        'STOCK_ADDED_ON_FUTURE',
      );
    });

    it('refuses a soft-deleted recipe but keeps showing one already held', async () => {
      const gone = await insertRecipe('Old Curry', { isDeleted: true });
      await expectDomainError(
        caller().storage.create({
          location: 'freezer',
          target: { kind: 'recipe', recipeId: gone },
          quantity: '1',
          addedOn: todayIso,
        }),
        'NOT_FOUND',
        'STOCK_TARGET_NOT_FOUND',
      );

      const curry = await insertRecipe('Curry');
      const { id } = await caller().storage.create({
        location: 'freezer',
        target: { kind: 'recipe', recipeId: curry },
        quantity: '1',
        addedOn: todayIso,
      });
      await db
        .update(recipes)
        .set({ isDeleted: true })
        .where(eq(recipes.id, curry));
      expect((await itemById(id))?.target).toMatchObject({
        kind: 'recipe',
        isDeleted: true,
      });
    });

    it('refuses portions that aren’t whole or half', async () => {
      const { id } = await caller().storage.create({
        location: 'freezer',
        target: { kind: 'recipe', recipeId: stewId },
        quantity: '1.5',
        addedOn: todayIso,
      });
      await expectDomainError(
        caller().storage.update({ id, patch: { quantity: '1.2' } }),
        'BAD_REQUEST',
        'STOCK_PORTIONS_NOT_HALVES',
      );
    });
  });

  describe('Use-by', () => {
    it('defaults from the ingredient’s shelf life in the Fridge', async () => {
      const { id } = await caller().storage.create({
        location: 'fridge',
        target: { kind: 'ingredient', ingredientId: chickenId },
        quantity: '200',
        addedOn: iso(-1),
      });
      expect((await itemById(id))?.useBy).toBe(iso(1));
    });

    it('defaults to 3 days for a dish', async () => {
      const { id } = await caller().storage.create({
        location: 'fridge',
        target: { kind: 'recipe', recipeId: stewId },
        quantity: '2',
        addedOn: todayIso,
      });
      expect((await itemById(id))?.useBy).toBe(iso(3));
    });

    it('has no default for an ingredient with no shelf life, and takes a given one', async () => {
      const blank = await addCod('100', 'fridge');
      expect((await itemById(blank))?.useBy).toBeNull();

      const { id } = await caller().storage.create({
        location: 'fridge',
        target: { kind: 'ingredient', ingredientId: chickenId },
        quantity: '200',
        addedOn: todayIso,
        useBy: iso(5),
      });
      expect((await itemById(id))?.useBy).toBe(iso(5));
    });

    it('sets a fresh default from today when moved into the Fridge, and clears it when moved out', async () => {
      const { id } = await caller().storage.create({
        location: 'freezer',
        target: { kind: 'ingredient', ingredientId: chickenId },
        quantity: '200',
        addedOn: iso(-30),
      });
      await caller().storage.update({ id, patch: { location: 'fridge' } });
      expect((await itemById(id))?.useBy).toBe(iso(2));

      await caller().storage.update({ id, patch: { useBy: iso(4) } });
      expect((await itemById(id))?.useBy).toBe(iso(4));

      await caller().storage.update({ id, patch: { location: 'pantry' } });
      const moved = await itemById(id);
      expect(moved?.location).toBe('pantry');
      expect(moved?.useBy).toBeNull();
    });

    it('refuses a Use-by outside the Fridge', async () => {
      const id = await addCod();
      await expect(
        caller().storage.update({ id, patch: { useBy: iso(2) } }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('editing amounts', () => {
    it('updates an amount and deletes the item at zero', async () => {
      const id = await addCod('500');
      await caller().storage.update({ id, patch: { quantity: '450' } });
      expect((await itemById(id))?.quantity).toBe('450.000');

      const result = await caller().storage.update({
        id,
        patch: { quantity: '0' },
      });
      expect(result).toEqual({ id, deleted: true, releasedReservations: 0 });
      expect(await itemById(id)).toBeUndefined();
    });

    it('asks before lowering below what’s reserved, then releases the latest needed', async () => {
      const id = await addCod('500');
      await reserve(id, '200', addDays(today, 1));
      await reserve(id, '200', addDays(today, 4));

      const cause = await expectDomainError(
        caller().storage.update({ id, patch: { quantity: '300' } }),
        'CONFLICT',
        'STOCK_RESERVED',
      );
      expect(cause).toMatchObject({ quantity: '300.000', reserved: '400.000' });
      expect((await itemById(id))?.quantity).toBe('500.000');

      const result = await caller().storage.update({
        id,
        patch: { quantity: '300' },
        releaseReservations: true,
      });
      expect(result.releasedReservations).toBe(1);
      const left = await db.select().from(stockReservations);
      expect(left).toHaveLength(1);
      expect(left[0]?.neededOn).toEqual(addDays(today, 1));
    });

    it('lowers freely while what’s reserved still fits', async () => {
      const id = await addCod('500');
      await reserve(id, '200', addDays(today, 1));
      const result = await caller().storage.update({
        id,
        patch: { quantity: '200' },
      });
      expect(result.releasedReservations).toBe(0);
    });

    it('asks before deleting an item with Reservations', async () => {
      const id = await addCod('500');
      await reserve(id, '100', addDays(today, 1));
      await expectDomainError(
        caller().storage.delete({ id }),
        'CONFLICT',
        'STOCK_RESERVED',
      );
      const result = await caller().storage.delete({
        id,
        releaseReservations: true,
      });
      expect(result).toEqual({ id, releasedReservations: 1 });
      expect(await db.select().from(stockReservations)).toHaveLength(0);
    });
  });

  describe('removing a whole row', () => {
    it('deletes every item at once', async () => {
      const first = await addCod('500');
      const second = await addCod('250');
      const result = await caller().storage.deleteMany({
        ids: [second, first, second],
      });
      expect(result).toEqual({
        ids: [first, second].sort((a, b) => a - b),
        releasedReservations: 0,
      });
      expect(await itemById(first)).toBeUndefined();
      expect(await itemById(second)).toBeUndefined();
    });

    it('asks before deleting items with Reservations, and removes none', async () => {
      const free = await addCod('500');
      const held = await addCod('250');
      await reserve(held, '100', addDays(today, 1));
      await expectDomainError(
        caller().storage.deleteMany({ ids: [free, held] }),
        'CONFLICT',
        'STOCK_RESERVED',
      );
      expect(await itemById(free)).toBeDefined();

      const result = await caller().storage.deleteMany({
        ids: [free, held],
        releaseReservations: true,
      });
      expect(result.releasedReservations).toBe(1);
      expect(await db.select().from(stockReservations)).toHaveLength(0);
    });

    it('removes none if one item has already gone', async () => {
      const own = await addCod('500');
      await expectDomainError(
        caller().storage.deleteMany({ ids: [own, own + 1000] }),
        'NOT_FOUND',
        'STOCK_ITEM_NOT_FOUND',
      );
      expect(await itemById(own)).toBeDefined();
    });
  });

  describe('settling before a write', () => {
    it('settles before an edit, so eaten food isn’t counted as reserved', async () => {
      const id = await addCod('500');
      await reserve(id, '300', addDays(today, -1));
      const result = await caller().storage.update({
        id,
        patch: { quantity: '100' },
      });
      expect(result).toEqual({ id, deleted: false, releasedReservations: 0 });
      expect(await db.select().from(stockReservations)).toHaveLength(0);
    });

    it('settles before a delete, so it needs no go-ahead for eaten food', async () => {
      const id = await addCod('500');
      await reserve(id, '300', addDays(today, -1));
      const result = await caller().storage.delete({ id });
      expect(result).toEqual({ id, releasedReservations: 0 });
    });
  });

  describe('settling on read', () => {
    it('settles due Reservations before listing', async () => {
      const id = await addCod('500');
      await reserve(id, '100', addDays(today, -1));
      await reserve(id, '100', today);
      const item = await itemById(id);
      expect(item?.quantity).toBe('400.000');
      expect(item?.reserved).toBe('100.000');
    });
  });

  describe('household scoping', () => {
    async function insertForeignItem(): Promise<number> {
      const foreignIngredient = await insertIngredient(
        'Foreign Cod',
        null,
        gramsUnitId,
        OTHER_HOUSEHOLD_ID,
      );
      const [row] = await db
        .insert(stockItems)
        .values({
          householdId: OTHER_HOUSEHOLD_ID,
          location: 'freezer',
          ingredientId: foreignIngredient,
          quantity: '500',
          addedOn: today,
        })
        .returning({ id: stockItems.id });
      if (!row) throw new Error('foreign insert failed');
      return row.id;
    }

    it('lists only this household’s items', async () => {
      await insertForeignItem();
      await addCod();
      const { items } = await caller().storage.list();
      expect(items).toHaveLength(1);
    });

    it('can’t update or delete another household’s item', async () => {
      const foreign = await insertForeignItem();
      await expectDomainError(
        caller().storage.update({ id: foreign, patch: { quantity: '1' } }),
        'NOT_FOUND',
        'STOCK_ITEM_NOT_FOUND',
      );
      await expectDomainError(
        caller().storage.delete({ id: foreign }),
        'NOT_FOUND',
        'STOCK_ITEM_NOT_FOUND',
      );
      await expectDomainError(
        caller().storage.deleteMany({ ids: [foreign] }),
        'NOT_FOUND',
        'STOCK_ITEM_NOT_FOUND',
      );
    });

    it('can’t add another household’s ingredient or recipe', async () => {
      const foreignIngredient = await insertIngredient(
        'Foreign Lemon',
        null,
        gramsUnitId,
        OTHER_HOUSEHOLD_ID,
      );
      const foreignRecipe = await insertRecipe('Foreign Stew', {
        householdId: OTHER_HOUSEHOLD_ID,
      });
      await expectDomainError(
        caller().storage.create({
          location: 'pantry',
          target: { kind: 'ingredient', ingredientId: foreignIngredient },
          quantity: '1',
          addedOn: todayIso,
        }),
        'NOT_FOUND',
        'STOCK_TARGET_NOT_FOUND',
      );
      await expectDomainError(
        caller().storage.create({
          location: 'pantry',
          target: { kind: 'recipe', recipeId: foreignRecipe },
          quantity: '1',
          addedOn: todayIso,
        }),
        'NOT_FOUND',
        'STOCK_TARGET_NOT_FOUND',
      );
    });
  });

  describe('ingredients held in storage', () => {
    it('can’t be deleted', async () => {
      await caller().storage.create({
        location: 'pantry',
        target: { kind: 'ingredient', ingredientId: lemonId },
        quantity: '3',
        addedOn: todayIso,
      });
      const cause = await expectDomainError(
        caller().ingredients.delete({ id: lemonId }),
        'CONFLICT',
        'INGREDIENT_IN_USE',
      );
      expect(cause.inStorage).toBe(true);
    });

    it('can’t be deleted while a Stock item is being added', async () => {
      const withTransaction = makeWithTransaction(db);
      let commitAdd!: () => void;
      const addMayCommit = new Promise<void>((resolve) => {
        commitAdd = resolve;
      });
      let added!: () => void;
      const hasAdded = new Promise<void>((resolve) => {
        added = resolve;
      });
      const adding = withTransaction(async (tx) => {
        await tx.insert(stockItems).values({
          householdId: CURRENT_HOUSEHOLD_ID,
          location: 'pantry',
          ingredientId: lemonId,
          quantity: '3',
          addedOn: today,
        });
        added();
        await addMayCommit;
      });
      await hasAdded;
      const deleting = caller().ingredients.delete({ id: lemonId });
      await new Promise((resolve) => setTimeout(resolve, 200));
      commitAdd();
      await adding;
      const cause = await expectDomainError(
        deleting,
        'CONFLICT',
        'INGREDIENT_IN_USE',
      );
      expect(cause.inStorage).toBe(true);
    });

    it('can’t change unit, but can keep it while other fields change', async () => {
      await addCod();
      await expectDomainError(
        caller().ingredients.update({
          id: codId,
          patch: { defaultUnitId: piecesUnitId },
        }),
        'CONFLICT',
        'INGREDIENT_UNIT_IN_STOCK',
      );
      const updated = await caller().ingredients.update({
        id: codId,
        patch: { defaultUnitId: gramsUnitId, name: 'Cod Loin' },
      });
      expect(updated.name).toBe('Cod Loin');
    });
  });
});
