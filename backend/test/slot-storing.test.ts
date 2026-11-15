import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { UpdateSlotInput } from '../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import {
  accounts,
  sessions,
  users,
  verifications,
} from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import {
  mealPlans,
  mealPlanSlotItems,
  mealPlanSlots,
} from '../src/db/schema/meal-plans.ts';
import { recipes } from '../src/db/schema/recipes.ts';
import { mealOccasions } from '../src/db/schema/reference.ts';
import { stockItems, stockReservations } from '../src/db/schema/storage.ts';
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

const USER_ID = 'user-slot-storing-test-1';
const USER_EMAIL = 'slot-storing@example.com';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009de';

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

async function expectConstraint(
  query: Promise<unknown>,
  constraint: string,
): Promise<void> {
  try {
    await query;
  } catch (err) {
    const cause = (err as { cause?: { constraint?: string } }).cause;
    expect(cause?.constraint).toBe(constraint);
    return;
  }
  throw new Error(`expected the ${constraint} constraint to fail`);
}

describe('storing portions from the plan', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let lunchId!: number;
  let dinnerId!: number;
  let chilliId!: number;
  let planId!: number;
  const today = todayInLondon();
  const todayIso = formatCivilDate(today);

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
        ${recipes},
        ${mealOccasions},
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
      name: 'Storing Tester',
      emailVerified: true,
    });
    const occasions = await db
      .insert(mealOccasions)
      .values([{ name: 'Lunch' }, { name: 'Dinner' }])
      .returning({ id: mealOccasions.id });
    lunchId = occasions[0]?.id ?? 0;
    dinnerId = occasions[1]?.id ?? 0;
    chilliId = await insertRecipe('Chilli');
    planId = await insertPlan(CURRENT_HOUSEHOLD_ID, addDays(today, -3));
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
        id: 'session-slot-storing-1',
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
        name: 'Storing Tester',
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
    householdId: string = CURRENT_HOUSEHOLD_ID,
  ): Promise<number> {
    const [row] = await db
      .insert(recipes)
      .values({ householdId, name, baseServings: 4, addedByUserId: USER_ID })
      .returning({ id: recipes.id });
    if (!row) throw new Error('recipe insert failed');
    return row.id;
  }

  async function insertPlan(householdId: string, start: Date): Promise<number> {
    const [row] = await db
      .insert(mealPlans)
      .values({
        householdId,
        createdByUserId: USER_ID,
        startDate: start,
        endDate: addDays(start, 6),
      })
      .returning({ id: mealPlans.id });
    if (!row) throw new Error('plan insert failed');
    return row.id;
  }

  // A Cooking slot with one dish; returns the slot and slot-item ids.
  async function cookingSlot(
    options: {
      plan?: number;
      date?: Date;
      occasionId?: number;
      prepared?: number;
      eaten?: number;
      frozen?: number;
      chilled?: number;
    } = {},
  ): Promise<{ slotId: number; itemId: number }> {
    const [slot] = await db
      .insert(mealPlanSlots)
      .values({
        planId: options.plan ?? planId,
        date: options.date ?? today,
        occasionId: options.occasionId ?? dinnerId,
        slotType: 'recipe',
      })
      .returning({ id: mealPlanSlots.id });
    if (!slot) throw new Error('slot insert failed');
    const [item] = await db
      .insert(mealPlanSlotItems)
      .values({
        slotId: slot.id,
        recipeId: chilliId,
        prepared: options.prepared ?? 8,
        eaten: options.eaten ?? 2,
        frozen: options.frozen ?? 0,
        chilled: options.chilled ?? 0,
        sortOrder: 0,
      })
      .returning({ id: mealPlanSlotItems.id });
    if (!item) throw new Error('item insert failed');
    return { slotId: slot.id, itemId: item.id };
  }

  function editInput(
    slotId: number,
    dish: { prepared?: number; eaten?: number; frozen?: number },
    extra: Partial<UpdateSlotInput> = {},
  ): UpdateSlotInput {
    return {
      slotId,
      slotType: 'recipe',
      leftoversSource: null,
      chefUserId: null,
      comment: null,
      items: [
        {
          recipeId: chilliId,
          prepared: dish.prepared ?? 8,
          eaten: dish.eaten ?? 2,
          ...(dish.frozen !== undefined && { frozen: dish.frozen }),
          sortOrder: 0,
        },
      ],
      dinerUserIds: [],
      guestCount: 0,
      ...extra,
    };
  }

  async function readItem(itemId: number) {
    const [row] = await db
      .select()
      .from(mealPlanSlotItems)
      .where(eq(mealPlanSlotItems.id, itemId));
    return row;
  }

  async function linkedStock(itemId: number) {
    return db
      .select({
        id: stockItems.id,
        location: stockItems.location,
        quantity: stockItems.quantity,
        addedOn: stockItems.addedOn,
        useBy: stockItems.useBy,
        recipeId: stockItems.recipeId,
      })
      .from(stockItems)
      .where(eq(stockItems.sourceSlotItemId, itemId))
      .orderBy(stockItems.id);
  }

  async function reserve(stockItemId: number, amount: string): Promise<void> {
    await db.insert(stockReservations).values({
      householdId: CURRENT_HOUSEHOLD_ID,
      stockItemId,
      planId,
      ingredientId: null,
      slotItemId: (
        await cookingSlot({ date: addDays(today, 1), prepared: 0, eaten: 2 })
      ).itemId,
      amount,
      neededOn: addDays(today, 1),
    });
  }

  describe('the counts and their CHECK', () => {
    it('starts both counts at zero', async () => {
      const { itemId } = await cookingSlot();
      const row = await readItem(itemId);
      expect(row?.frozen).toBe(0);
      expect(row?.chilled).toBe(0);
    });

    it('rejects eaten plus stored above prepared', async () => {
      const { itemId } = await cookingSlot({ prepared: 4, eaten: 2 });
      await expectConstraint(
        db
          .update(mealPlanSlotItems)
          .set({ frozen: 2, chilled: 1 })
          .where(eq(mealPlanSlotItems.id, itemId)),
        'meal_plan_slot_items_stored_within_prepared',
      );
    });

    it('rejects a negative count', async () => {
      const { itemId } = await cookingSlot();
      await expectConstraint(
        db
          .update(mealPlanSlotItems)
          .set({ chilled: -1 })
          .where(eq(mealPlanSlotItems.id, itemId)),
        'meal_plan_slot_items_chilled_non_negative',
      );
    });

    it('leaves a leftovers row with nothing prepared and nothing stored valid', async () => {
      const { itemId } = await cookingSlot({ prepared: 0, eaten: 3 });
      expect((await readItem(itemId))?.eaten).toBe(3);
    });
  });

  describe('freezing from the slot editor', () => {
    it('makes one Freezer Stock item of the raised portions, dated today and linked', async () => {
      const { slotId, itemId } = await cookingSlot();
      const result = await caller().slots.update(
        editInput(slotId, { frozen: 2 }),
      );

      expect(result.storedLimits).toEqual([]);
      expect(result.slot.items[0]).toMatchObject({
        id: itemId,
        frozen: 2,
        chilled: 0,
      });
      const stock = await linkedStock(itemId);
      expect(stock).toHaveLength(1);
      expect(stock[0]).toMatchObject({
        location: 'freezer',
        quantity: '2.000',
        recipeId: chilliId,
        useBy: null,
      });
      expect(formatCivilDate(stock[0]?.addedOn ?? new Date(0))).toBe(todayIso);
    });

    it('freezes a dish added in the same save', async () => {
      const [slot] = await db
        .insert(mealPlanSlots)
        .values({
          planId,
          date: today,
          occasionId: dinnerId,
          slotType: 'empty',
        })
        .returning({ id: mealPlanSlots.id });
      const result = await caller().slots.update(
        editInput(slot?.id ?? 0, { frozen: 3 }),
      );
      const item = result.slot.items[0];
      expect(item?.frozen).toBe(3);
      const stock = await linkedStock(item?.id ?? 0);
      expect(stock.map((row) => row.quantity)).toEqual(['3.000']);
    });

    it('adds a second Stock item when raised again later', async () => {
      const { slotId, itemId } = await cookingSlot({ frozen: 0 });
      await caller().slots.update(editInput(slotId, { frozen: 2 }));
      await caller().slots.update(editInput(slotId, { frozen: 4 }));
      const stock = await linkedStock(itemId);
      expect(stock.map((row) => row.quantity)).toEqual(['2.000', '2.000']);
    });

    it('keeps the current count when the save leaves Freeze out', async () => {
      const { slotId, itemId } = await cookingSlot();
      await caller().slots.update(editInput(slotId, { frozen: 2 }));
      await caller().slots.update(editInput(slotId, {}));
      expect((await readItem(itemId))?.frozen).toBe(2);
      expect(await linkedStock(itemId)).toHaveLength(1);
    });

    it('takes back portions when Freeze is lowered, newest first', async () => {
      const { slotId, itemId } = await cookingSlot();
      await caller().slots.update(editInput(slotId, { frozen: 2 }));
      await caller().slots.update(editInput(slotId, { frozen: 4 }));
      const result = await caller().slots.update(
        editInput(slotId, { frozen: 3 }),
      );
      expect(result.storedLimits).toEqual([]);
      expect((await readItem(itemId))?.frozen).toBe(3);
      expect((await linkedStock(itemId)).map((row) => row.quantity)).toEqual([
        '2.000',
        '1.000',
      ]);
    });

    it('stops at reserved portions and says how far it got', async () => {
      const { slotId, itemId } = await cookingSlot();
      await caller().slots.update(editInput(slotId, { frozen: 3 }));
      const [stock] = await linkedStock(itemId);
      await reserve(stock?.id ?? 0, '2');

      const result = await caller().slots.update(
        editInput(slotId, { frozen: 0 }),
      );
      expect(result.storedLimits).toEqual([
        { slotItemId: itemId, location: 'freezer', requested: 0, applied: 2 },
      ]);
      expect((await readItem(itemId))?.frozen).toBe(2);
      expect((await linkedStock(itemId)).map((row) => row.quantity)).toEqual([
        '2.000',
      ]);
    });

    it('stops at portions already used from storage', async () => {
      const { slotId, itemId } = await cookingSlot();
      await caller().slots.update(editInput(slotId, { frozen: 3 }));
      const [stock] = await linkedStock(itemId);
      await caller().storage.update({
        id: stock?.id ?? 0,
        patch: { quantity: '1' },
      });

      const result = await caller().slots.update(
        editInput(slotId, { frozen: 0 }),
      );
      expect(result.storedLimits[0]).toMatchObject({
        requested: 0,
        applied: 2,
      });
      expect((await readItem(itemId))?.frozen).toBe(2);
      expect(await linkedStock(itemId)).toHaveLength(0);
    });

    it('refuses a lower Prepare that leaves no room for portions it cannot take back, changing nothing', async () => {
      const { slotId, itemId } = await cookingSlot();
      await caller().slots.update(editInput(slotId, { frozen: 3 }));
      const [stock] = await linkedStock(itemId);
      await reserve(stock?.id ?? 0, '3');

      await expectDomainError(
        caller().slots.update(editInput(slotId, { prepared: 3, frozen: 0 })),
        'BAD_REQUEST',
        'SLOT_ITEM_STORED_EXCEEDS_PREPARED',
      );
      const row = await readItem(itemId);
      expect(row).toMatchObject({ prepared: 8, frozen: 3 });
      expect((await linkedStock(itemId)).map((r) => r.quantity)).toEqual([
        '3.000',
      ]);
    });

    it('rejects Eat plus Freeze above Prepare at the input', async () => {
      const { slotId } = await cookingSlot();
      await expect(
        caller().slots.update(
          editInput(slotId, { prepared: 4, eaten: 2, frozen: 3 }),
        ),
      ).rejects.toThrow(/Eat plus Freeze cannot exceed Prepare/);
    });
  });

  describe('keeping slot items, so stored portions stay linked', () => {
    it('keeps the item id across an unrelated edit', async () => {
      const { slotId, itemId } = await cookingSlot();
      await caller().slots.update(editInput(slotId, { frozen: 2 }));
      const result = await caller().slots.update(
        editInput(slotId, {}, { comment: 'Extra spicy', guestCount: 2 }),
      );
      expect(result.slot.items[0]?.id).toBe(itemId);
      expect(await linkedStock(itemId)).toHaveLength(1);
    });

    it('keeps item ids when a slot is moved or swapped', async () => {
      const source = await cookingSlot();
      const other = await insertRecipe('Soup');
      const [dest] = await db
        .insert(mealPlanSlots)
        .values({
          planId,
          date: today,
          occasionId: lunchId,
          slotType: 'recipe',
        })
        .returning({ id: mealPlanSlots.id });
      const [destItem] = await db
        .insert(mealPlanSlotItems)
        .values({
          slotId: dest?.id ?? 0,
          recipeId: other,
          prepared: 2,
          eaten: 2,
          sortOrder: 0,
        })
        .returning({ id: mealPlanSlotItems.id });

      const result = await caller().slots.relocate({
        sourceSlotId: source.slotId,
        destSlotId: dest?.id ?? 0,
      });
      expect(result.destSlot.items.map((item) => item.id)).toEqual([
        source.itemId,
      ]);
      expect(result.sourceSlot.items.map((item) => item.id)).toEqual([
        destItem?.id,
      ]);
    });

    it('leaves Stock items, unlinked, when the dish is removed', async () => {
      const { slotId, itemId } = await cookingSlot();
      await caller().slots.update(editInput(slotId, { frozen: 2 }));
      const [before] = await linkedStock(itemId);
      await caller().slots.update({
        ...editInput(slotId, {}),
        slotType: 'empty',
        items: [],
      });
      const [after] = await db
        .select({
          quantity: stockItems.quantity,
          source: stockItems.sourceSlotItemId,
        })
        .from(stockItems)
        .where(eq(stockItems.id, before?.id ?? 0));
      expect(after).toEqual({ quantity: '2.000', source: null });
    });
  });

  describe('slots.store', () => {
    it('keeps portions in the Fridge with the cooked-food Use-by', async () => {
      const { itemId } = await cookingSlot();
      const result = await caller().slots.store({
        slotItemId: itemId,
        frozen: 0,
        chilled: 2,
      });
      expect(result.slot.items[0]).toMatchObject({ frozen: 0, chilled: 2 });
      const [stock] = await linkedStock(itemId);
      expect(stock?.location).toBe('fridge');
      expect(formatCivilDate(stock?.useBy ?? new Date(0))).toBe(
        formatCivilDate(addDays(today, 3)),
      );
    });

    it('works on a slot whose day has passed', async () => {
      const { itemId } = await cookingSlot({ date: addDays(today, -2) });
      await caller().slots.store({ slotItemId: itemId, frozen: 2, chilled: 0 });
      const [stock] = await linkedStock(itemId);
      // Stored today, not on the slot's day.
      expect(formatCivilDate(stock?.addedOn ?? new Date(0))).toBe(todayIso);
    });

    it('sets both counts in one call, up and down', async () => {
      const { itemId } = await cookingSlot();
      await caller().slots.store({ slotItemId: itemId, frozen: 3, chilled: 1 });
      const result = await caller().slots.store({
        slotItemId: itemId,
        frozen: 1,
        chilled: 0,
      });
      expect(result.storedLimits).toEqual([]);
      const stock = await linkedStock(itemId);
      expect(stock.map((row) => [row.location, row.quantity])).toEqual([
        ['freezer', '1.000'],
      ]);
    });

    it('only takes Fridge portions back from the Fridge', async () => {
      const { itemId } = await cookingSlot();
      await caller().slots.store({ slotItemId: itemId, frozen: 2, chilled: 2 });
      await caller().slots.store({ slotItemId: itemId, frozen: 2, chilled: 0 });
      const stock = await linkedStock(itemId);
      expect(stock.map((row) => row.location)).toEqual(['freezer']);
    });

    it('caps a raise by Freezer portions that could not be taken back', async () => {
      const { itemId } = await cookingSlot();
      await caller().slots.store({ slotItemId: itemId, frozen: 6, chilled: 0 });
      const [eatenStock] = await linkedStock(itemId);
      await caller().storage.delete({ id: eatenStock?.id ?? 0 });

      const result = await caller().slots.store({
        slotItemId: itemId,
        frozen: 0,
        chilled: 6,
      });
      expect(result.storedLimits).toEqual([
        { slotItemId: itemId, location: 'freezer', requested: 0, applied: 6 },
        { slotItemId: itemId, location: 'fridge', requested: 6, applied: 0 },
      ]);
      expect(await readItem(itemId)).toMatchObject({ frozen: 6, chilled: 0 });
      expect(await linkedStock(itemId)).toHaveLength(0);
    });

    it('moves portions from the Freezer to the Fridge when they come back', async () => {
      const { itemId } = await cookingSlot();
      await caller().slots.store({ slotItemId: itemId, frozen: 6, chilled: 0 });
      const result = await caller().slots.store({
        slotItemId: itemId,
        frozen: 0,
        chilled: 6,
      });
      expect(result.storedLimits).toEqual([]);
      expect(
        (await linkedStock(itemId)).map((row) => [row.location, row.quantity]),
      ).toEqual([['fridge', '6.000']]);
    });

    it('refuses more than the dish has spare, storing nothing', async () => {
      const { itemId } = await cookingSlot({ prepared: 4, eaten: 2 });
      await expectDomainError(
        caller().slots.store({ slotItemId: itemId, frozen: 2, chilled: 1 }),
        'BAD_REQUEST',
        'SLOT_ITEM_STORE_EXCEEDS_SPARE',
      );
      expect(await linkedStock(itemId)).toHaveLength(0);
    });

    it("can't reach another household's dish", async () => {
      const otherPlan = await insertPlan(OTHER_HOUSEHOLD_ID, today);
      const { itemId } = await cookingSlot({ plan: otherPlan });
      await expectDomainError(
        caller().slots.store({ slotItemId: itemId, frozen: 1, chilled: 0 }),
        'NOT_FOUND',
        'SLOT_ITEM_NOT_FOUND',
      );
    });
  });

  describe('stored stock standing on its own', () => {
    it('leaves the plan unchanged when a stored item is edited, moved or deleted', async () => {
      const { itemId } = await cookingSlot();
      await caller().slots.store({ slotItemId: itemId, frozen: 3, chilled: 0 });
      const [stock] = await linkedStock(itemId);
      const id = stock?.id ?? 0;

      await caller().storage.update({ id, patch: { quantity: '2' } });
      await caller().storage.update({ id, patch: { location: 'fridge' } });
      expect(await readItem(itemId)).toMatchObject({ frozen: 3, chilled: 0 });
      await caller().storage.delete({ id });
      expect(await readItem(itemId)).toMatchObject({ frozen: 3, chilled: 0 });
    });
  });

  describe('what storing leaves alone', () => {
    it('leaves the shopping list, plant points and Health Score unchanged', async () => {
      const { itemId } = await cookingSlot();
      const before = await Promise.all([
        caller().shopping.getForPlan({ planId }),
        caller().plants.forPlan({ planId }),
        caller().healthScores.forPlan({ planId }),
      ]);
      await caller().slots.store({ slotItemId: itemId, frozen: 3, chilled: 2 });
      const after = await Promise.all([
        caller().shopping.getForPlan({ planId }),
        caller().plants.forPlan({ planId }),
        caller().healthScores.forPlan({ planId }),
      ]);
      expect(after).toEqual(before);
    });

    it('starts a duplicated plan at zero', async () => {
      const { itemId } = await cookingSlot({ date: addDays(today, -3) });
      await caller().slots.store({ slotItemId: itemId, frozen: 2, chilled: 1 });
      const { plan } = await caller().plans.duplicate({
        planId,
        newStartDate: formatCivilDate(addDays(today, 14)),
      });
      const copy = await caller().plans.get({ id: plan.id });
      const items = copy.slots.flatMap((slot) => slot.items);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ prepared: 8, frozen: 0, chilled: 0 });
    });
  });
});
