import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
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
import {
  mealPlans,
  mealPlanSlotDiners,
  mealPlanSlotItems,
  mealPlanSlots,
} from '../src/db/schema/meal-plans.ts';
import { recipes } from '../src/db/schema/recipes.ts';
import { mealOccasions } from '../src/db/schema/reference.ts';
import { todayInLondon } from '../src/lib/date-utils.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { appRouter } from '../src/trpc/router.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const USER_ID = 'user-slots-test-1';
const USER_EMAIL = 'slots@example.com';
const SESSION_ID = 'session-slots-test-1';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009cc';
const OTHER_USER_ID = 'user-slots-test-other';

describe('slots procedures', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;
  let occasionId!: number;
  let secondOccasionId!: number;

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
    await db.insert(users).values([
      {
        id: USER_ID,
        email: USER_EMAIL,
        name: 'Slot Tester',
        emailVerified: true,
      },
      {
        id: OTHER_USER_ID,
        email: 'other@example.com',
        name: 'Other User',
        emailVerified: true,
      },
    ]);
    const occasions = await db
      .insert(mealOccasions)
      .values([{ name: 'Lunch' }, { name: 'Dinner' }])
      .returning({ id: mealOccasions.id });
    const first = occasions[0];
    const second = occasions[1];
    if (!first || !second) throw new Error('expected two occasions');
    occasionId = first.id;
    secondOccasionId = second.id;
  });

  function makeContext(
    overrides: { authenticated?: boolean } = {},
  ): AppContext {
    const authenticated = overrides.authenticated ?? true;
    return {
      req: {} as AppContext['req'],
      reply: {} as AppContext['reply'],
      reqId: 'rid-test',
      db,
      cloudinary: {
        cloudName: 'test-cloud',
        apiKey: 'test-key',
        apiSecret: 'test-secret',
      },
      session: authenticated
        ? {
            id: SESSION_ID,
            userId: USER_ID,
            token: 'tok',
            expiresAt: new Date(Date.now() + 60_000),
            ipAddress: null,
            userAgent: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
      user: authenticated
        ? {
            id: USER_ID,
            email: USER_EMAIL,
            name: 'Slot Tester',
            emailVerified: true,
            image: null,
            themePreference: 'system',
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
    };
  }

  const createCaller = appRouter.createCaller;

  interface InsertPlanOptions {
    householdId?: string;
  }

  async function insertPlan(options: InsertPlanOptions = {}): Promise<number> {
    const today = todayInLondon();
    const inserted = await db
      .insert(mealPlans)
      .values({
        householdId: options.householdId ?? CURRENT_HOUSEHOLD_ID,
        createdByUserId: USER_ID,
        startDate: today,
        endDate: today,
      })
      .returning({ id: mealPlans.id });
    const row = inserted[0];
    if (!row) throw new Error('plan insert failed');
    return row.id;
  }

  async function insertSlot(
    planId: number,
    overrides: Partial<typeof mealPlanSlots.$inferInsert> = {},
  ): Promise<number> {
    const today = todayInLondon();
    const inserted = await db
      .insert(mealPlanSlots)
      .values({
        planId,
        date: today,
        occasionId,
        slotType: 'empty',
        ...overrides,
      })
      .returning({ id: mealPlanSlots.id });
    const row = inserted[0];
    if (!row) throw new Error('slot insert failed');
    return row.id;
  }

  async function insertRecipe(
    name: string,
    options: {
      isDeleted?: boolean;
      householdId?: string;
      isBase?: boolean;
    } = {},
  ): Promise<number> {
    const inserted = await db
      .insert(recipes)
      .values({
        householdId: options.householdId ?? CURRENT_HOUSEHOLD_ID,
        name,
        baseServings: 2,
        isBase: options.isBase ?? false,
        isDeleted: options.isDeleted ?? false,
        addedByUserId: USER_ID,
      })
      .returning({ id: recipes.id });
    const row = inserted[0];
    if (!row) throw new Error('recipe insert failed');
    return row.id;
  }

  async function insertBaseRecipe(name: string): Promise<number> {
    return insertRecipe(name, { isBase: true });
  }

  // Seed items directly onto a slot (bypasses the procedure) for arrange steps.
  async function seedItems(
    slotId: number,
    items: {
      recipeId: number;
      servings: number;
      kind: 'eat' | 'cook_ahead';
      sortOrder?: number;
    }[],
  ): Promise<void> {
    await db.insert(mealPlanSlotItems).values(
      items.map((item, index) => ({
        slotId,
        recipeId: item.recipeId,
        servings: item.servings,
        kind: item.kind,
        sortOrder: item.sortOrder ?? index,
      })),
    );
  }

  async function readItems(slotId: number) {
    return db
      .select({
        recipeId: mealPlanSlotItems.recipeId,
        servings: mealPlanSlotItems.servings,
        kind: mealPlanSlotItems.kind,
        sortOrder: mealPlanSlotItems.sortOrder,
      })
      .from(mealPlanSlotItems)
      .where(eq(mealPlanSlotItems.slotId, slotId))
      .orderBy(mealPlanSlotItems.sortOrder);
  }

  async function readDiners(slotId: number): Promise<string[]> {
    const rows = await db
      .select({ userId: mealPlanSlotDiners.userId })
      .from(mealPlanSlotDiners)
      .where(eq(mealPlanSlotDiners.slotId, slotId))
      .orderBy(mealPlanSlotDiners.userId);
    return rows.map((row) => row.userId);
  }

  describe('update — meal items', () => {
    it('assigns eat dishes to an empty slot', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const main = await insertRecipe('Roast');
      const side = await insertRecipe('Greens');
      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        dinerUserIds: [],
        guestCount: 0,
        slotType: 'recipe',
        chefUserId: null,
        comment: null,
        items: [
          { recipeId: main, servings: 4, kind: 'eat', sortOrder: 0 },
          { recipeId: side, servings: 4, kind: 'eat', sortOrder: 1 },
        ],
      });
      expect(result.slot.slotType).toBe('recipe');
      expect(result.slot.items).toHaveLength(2);
      expect(result.slot.items.map((i) => i.recipeId)).toEqual([main, side]);

      const persisted = await readItems(slotId);
      expect(persisted).toHaveLength(2);
      expect(persisted[0]).toMatchObject({ recipeId: main, kind: 'eat' });
    });

    it('full-replaces the item list on update', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId, { slotType: 'recipe' });
      const a = await insertRecipe('A');
      const b = await insertRecipe('B');
      await seedItems(slotId, [{ recipeId: a, servings: 2, kind: 'eat' }]);
      const caller = createCaller(makeContext());
      await caller.slots.update({
        slotId,
        dinerUserIds: [],
        guestCount: 0,
        slotType: 'recipe',
        chefUserId: null,
        comment: null,
        items: [{ recipeId: b, servings: 3, kind: 'eat', sortOrder: 0 }],
      });
      const persisted = await readItems(slotId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ recipeId: b, servings: 3 });
    });

    it('clears items when transitioning recipe → eat_out', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId, { slotType: 'recipe' });
      const r = await insertRecipe('Curry');
      await seedItems(slotId, [{ recipeId: r, servings: 2, kind: 'eat' }]);
      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        dinerUserIds: [],
        guestCount: 0,
        slotType: 'eat_out',
        chefUserId: null,
        comment: null,
        items: [],
      });
      expect(result.slot.slotType).toBe('eat_out');
      expect(result.slot.items).toHaveLength(0);
      expect(await readItems(slotId)).toHaveLength(0);
    });

    it('persists chef and comment', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const r = await insertRecipe('Soup');
      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        dinerUserIds: [],
        guestCount: 0,
        slotType: 'recipe',
        chefUserId: USER_ID,
        comment: 'extra spicy',
        items: [{ recipeId: r, servings: 2, kind: 'eat', sortOrder: 0 }],
      });
      expect(result.slot.chefUserId).toBe(USER_ID);
      expect(result.slot.comment).toBe('extra spicy');
    });

    it('rejects an unknown chef', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const r = await insertRecipe('Soup');
      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          dinerUserIds: [],
          guestCount: 0,
          slotType: 'recipe',
          chefUserId: 'ghost-user',
          comment: null,
          items: [{ recipeId: r, servings: 2, kind: 'eat', sortOrder: 0 }],
        }),
      ).rejects.toMatchObject({ cause: { code: 'SLOT_CHEF_NOT_FOUND' } });
    });

    it('returns NOT_FOUND for a slot in another household', async () => {
      const otherPlan = await insertPlan({ householdId: OTHER_HOUSEHOLD_ID });
      const slotId = await insertSlot(otherPlan);
      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          dinerUserIds: [],
          guestCount: 0,
          slotType: 'empty',
          chefUserId: null,
          comment: null,
          items: [],
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects without a session', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.slots.update({
          slotId,
          dinerUserIds: [],
          guestCount: 0,
          slotType: 'empty',
          chefUserId: null,
          comment: null,
          items: [],
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('cook-ahead items', () => {
    it('adds a cook-ahead base item alongside an eat dish', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const meal = await insertRecipe('Chilli');
      const base = await insertBaseRecipe('Bean Base');
      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        dinerUserIds: [],
        guestCount: 0,
        slotType: 'recipe',
        chefUserId: null,
        comment: null,
        items: [
          { recipeId: meal, servings: 4, kind: 'eat', sortOrder: 0 },
          { recipeId: base, servings: 12, kind: 'cook_ahead', sortOrder: 1 },
        ],
      });
      expect(result.slot.items).toHaveLength(2);
      const cook = result.slot.items.find((i) => i.kind === 'cook_ahead');
      expect(cook).toMatchObject({ recipeId: base, servings: 12 });
    });

    it('allows a cook-ahead base on an eat-out slot (decoupled)', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const base = await insertBaseRecipe('Bean Base');
      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        dinerUserIds: [],
        guestCount: 0,
        slotType: 'eat_out',
        chefUserId: null,
        comment: null,
        items: [
          { recipeId: base, servings: 8, kind: 'cook_ahead', sortOrder: 0 },
        ],
      });
      expect(result.slot.slotType).toBe('eat_out');
      expect(result.slot.items).toHaveLength(1);
    });

    it('rejects a cook-ahead item that references a non-base recipe', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const notBase = await insertRecipe('Regular');
      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          dinerUserIds: [],
          guestCount: 0,
          slotType: 'eat_out',
          chefUserId: null,
          comment: null,
          items: [
            {
              recipeId: notBase,
              servings: 8,
              kind: 'cook_ahead',
              sortOrder: 0,
            },
          ],
        }),
      ).rejects.toMatchObject({
        cause: { code: 'SLOT_ITEM_COOK_AHEAD_NOT_BASE' },
      });
    });
  });

  describe('recipe pickability + coherence', () => {
    it('rejects a newly added deleted recipe', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const gone = await insertRecipe('Gone', { isDeleted: true });
      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          dinerUserIds: [],
          guestCount: 0,
          slotType: 'recipe',
          chefUserId: null,
          comment: null,
          items: [{ recipeId: gone, servings: 2, kind: 'eat', sortOrder: 0 }],
        }),
      ).rejects.toMatchObject({ cause: { code: 'SLOT_RECIPE_NOT_PICKABLE' } });
    });

    it('keeps an item whose recipe was soft-deleted after assignment', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId, { slotType: 'recipe' });
      const r = await insertRecipe('Will be deleted');
      await seedItems(slotId, [{ recipeId: r, servings: 2, kind: 'eat' }]);
      await db
        .update(recipes)
        .set({ isDeleted: true })
        .where(eq(recipes.id, r));
      const caller = createCaller(makeContext());
      // Re-saving the same item (servings edit) must not be rejected.
      const result = await caller.slots.update({
        slotId,
        dinerUserIds: [],
        guestCount: 0,
        slotType: 'recipe',
        chefUserId: null,
        comment: null,
        items: [{ recipeId: r, servings: 3, kind: 'eat', sortOrder: 0 }],
      });
      expect(result.slot.items[0]).toMatchObject({ recipeId: r, servings: 3 });
    });

    it('rejects a recipe from another household', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const foreign = await insertRecipe('Foreign', {
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          dinerUserIds: [],
          guestCount: 0,
          slotType: 'recipe',
          chefUserId: null,
          comment: null,
          items: [
            { recipeId: foreign, servings: 2, kind: 'eat', sortOrder: 0 },
          ],
        }),
      ).rejects.toMatchObject({
        cause: { code: 'SLOT_RECIPE_CROSS_HOUSEHOLD' },
      });
    });
  });

  describe('relocate', () => {
    it('moves a populated source onto an empty dest (source becomes empty)', async () => {
      const planId = await insertPlan();
      const sourceId = await insertSlot(planId, { slotType: 'recipe' });
      const destId = await insertSlot(planId, { occasionId: secondOccasionId });
      const r = await insertRecipe('Lentils');
      await seedItems(sourceId, [{ recipeId: r, servings: 4, kind: 'eat' }]);

      const caller = createCaller(makeContext());
      const result = await caller.slots.relocate({
        sourceSlotId: sourceId,
        destSlotId: destId,
      });
      expect(result.destSlot.slotType).toBe('recipe');
      expect(result.destSlot.items).toHaveLength(1);
      expect(result.sourceSlot.slotType).toBe('empty');
      expect(result.sourceSlot.items).toHaveLength(0);
      expect(await readItems(sourceId)).toHaveLength(0);
      expect(await readItems(destId)).toHaveLength(1);
    });

    it('swaps two populated slots', async () => {
      const planId = await insertPlan();
      const sourceId = await insertSlot(planId, { slotType: 'recipe' });
      const destId = await insertSlot(planId, {
        occasionId: secondOccasionId,
        slotType: 'recipe',
      });
      const a = await insertRecipe('A');
      const b = await insertRecipe('B');
      await seedItems(sourceId, [{ recipeId: a, servings: 2, kind: 'eat' }]);
      await seedItems(destId, [{ recipeId: b, servings: 5, kind: 'eat' }]);

      const caller = createCaller(makeContext());
      const result = await caller.slots.relocate({
        sourceSlotId: sourceId,
        destSlotId: destId,
      });
      expect(result.destSlot.items[0]).toMatchObject({ recipeId: a });
      expect(result.sourceSlot.items[0]).toMatchObject({ recipeId: b });
    });

    it('rejects relocating across plans', async () => {
      const planA = await insertPlan();
      const planB = await insertPlan();
      const sourceId = await insertSlot(planA);
      const destId = await insertSlot(planB);
      const caller = createCaller(makeContext());
      await expect(
        caller.slots.relocate({ sourceSlotId: sourceId, destSlotId: destId }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('carries diners and guest count with a moved slot', async () => {
      const planId = await insertPlan();
      const sourceId = await insertSlot(planId, { slotType: 'recipe' });
      const destId = await insertSlot(planId, { occasionId: secondOccasionId });
      const r = await insertRecipe('Stew');
      await caller_seedRecipeWithDiners(sourceId, r);

      const caller = createCaller(makeContext());
      const result = await caller.slots.relocate({
        sourceSlotId: sourceId,
        destSlotId: destId,
      });
      expect(result.destSlot.dinerUserIds).toEqual([USER_ID]);
      expect(result.destSlot.guestCount).toBe(2);
      expect(result.sourceSlot.dinerUserIds).toEqual([]);
      expect(result.sourceSlot.guestCount).toBe(0);
      expect(await readDiners(destId)).toEqual([USER_ID]);
      expect(await readDiners(sourceId)).toEqual([]);
    });

    // Arrange helper: a recipe slot with one named diner + two guests, set
    // through the procedure so the diner/guest rows exist for the move.
    async function caller_seedRecipeWithDiners(
      slotId: number,
      recipeId: number,
    ): Promise<void> {
      const caller = createCaller(makeContext());
      await caller.slots.update({
        slotId,
        slotType: 'recipe',
        chefUserId: null,
        comment: null,
        items: [{ recipeId, servings: 4, kind: 'eat', sortOrder: 0 }],
        dinerUserIds: [USER_ID],
        guestCount: 2,
      });
    }
  });

  describe("update — who's eating", () => {
    it('persists named diners and a guest count', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const r = await insertRecipe('Tagine');
      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'recipe',
        chefUserId: null,
        comment: null,
        items: [{ recipeId: r, servings: 4, kind: 'eat', sortOrder: 0 }],
        dinerUserIds: [USER_ID, OTHER_USER_ID],
        guestCount: 3,
      });
      expect(result.slot.dinerUserIds).toEqual([USER_ID, OTHER_USER_ID]);
      expect(result.slot.guestCount).toBe(3);
      expect(await readDiners(slotId)).toEqual([USER_ID, OTHER_USER_ID]);
    });

    it('full-replaces the diner set on update', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId, { slotType: 'recipe' });
      const r = await insertRecipe('Pho');
      const caller = createCaller(makeContext());
      await caller.slots.update({
        slotId,
        slotType: 'recipe',
        chefUserId: null,
        comment: null,
        items: [{ recipeId: r, servings: 2, kind: 'eat', sortOrder: 0 }],
        dinerUserIds: [USER_ID, OTHER_USER_ID],
        guestCount: 1,
      });
      const result = await caller.slots.update({
        slotId,
        slotType: 'recipe',
        chefUserId: null,
        comment: null,
        items: [{ recipeId: r, servings: 2, kind: 'eat', sortOrder: 0 }],
        dinerUserIds: [OTHER_USER_ID],
        guestCount: 0,
      });
      expect(result.slot.dinerUserIds).toEqual([OTHER_USER_ID]);
      expect(result.slot.guestCount).toBe(0);
      expect(await readDiners(slotId)).toEqual([OTHER_USER_ID]);
    });

    it('drops diners and guests when the slot is cleared to empty', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId, { slotType: 'recipe' });
      const r = await insertRecipe('Ramen');
      const caller = createCaller(makeContext());
      await caller.slots.update({
        slotId,
        slotType: 'recipe',
        chefUserId: null,
        comment: null,
        items: [{ recipeId: r, servings: 2, kind: 'eat', sortOrder: 0 }],
        dinerUserIds: [USER_ID],
        guestCount: 2,
      });
      const result = await caller.slots.update({
        slotId,
        slotType: 'empty',
        chefUserId: null,
        comment: null,
        items: [],
        dinerUserIds: [],
        guestCount: 0,
      });
      expect(result.slot.dinerUserIds).toEqual([]);
      expect(result.slot.guestCount).toBe(0);
      expect(await readDiners(slotId)).toEqual([]);
    });

    it('rejects an unknown diner', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const r = await insertRecipe('Dal');
      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          chefUserId: null,
          comment: null,
          items: [{ recipeId: r, servings: 2, kind: 'eat', sortOrder: 0 }],
          dinerUserIds: ['ghost-user'],
          guestCount: 0,
        }),
      ).rejects.toMatchObject({ cause: { code: 'SLOT_DINER_NOT_FOUND' } });
    });
  });
});
