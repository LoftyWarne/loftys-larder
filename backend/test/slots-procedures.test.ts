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
import { mealPlans, mealPlanSlots } from '../src/db/schema/meal-plans.ts';
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
    options: { isDeleted?: boolean; householdId?: string } = {},
  ): Promise<number> {
    const inserted = await db
      .insert(recipes)
      .values({
        householdId: options.householdId ?? CURRENT_HOUSEHOLD_ID,
        name,
        baseServings: 2,
        isBase: false,
        isDeleted: options.isDeleted ?? false,
        addedByUserId: USER_ID,
      })
      .returning({ id: recipes.id });
    const row = inserted[0];
    if (!row) throw new Error('recipe insert failed');
    return row.id;
  }

  async function readSlot(slotId: number) {
    const rows = await db
      .select()
      .from(mealPlanSlots)
      .where(eq(mealPlanSlots.id, slotId));
    const row = rows[0];
    if (!row) throw new Error('slot not found');
    return row;
  }

  describe('state transitions', () => {
    it('assigns a recipe to an empty slot', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const recipeId = await insertRecipe('Lentil Curry');

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 4,
        chefUserId: USER_ID,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: 'extra coriander',
      });

      expect(result.slot.slotType).toBe('recipe');
      expect(result.slot.recipeId).toBe(recipeId);
      expect(result.slot.numberOfServings).toBe(4);
      expect(result.slot.chefUserId).toBe(USER_ID);
      expect(result.slot.comment).toBe('extra coriander');
      expect(result.slot.recipe?.name).toBe('Lentil Curry');

      const row = await readSlot(slotId);
      expect(row.slotType).toBe('recipe');
      expect(row.recipeId).toBe(recipeId);
      expect(row.numberOfServings).toBe(4);
    });

    it('transitions recipe to eat_out, nulling recipe and servings', async () => {
      const planId = await insertPlan();
      const recipeId = await insertRecipe('Tofu Stir Fry');
      const slotId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId,
        numberOfServings: 2,
        chefUserId: USER_ID,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: 'leftover marinade',
      });

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'eat_out',
        recipeId: null,
        numberOfServings: null,
        chefUserId: USER_ID,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: 'pizza place',
      });

      expect(result.slot.slotType).toBe('eat_out');
      expect(result.slot.recipeId).toBeNull();
      expect(result.slot.numberOfServings).toBeNull();
      expect(result.slot.chefUserId).toBe(USER_ID);
      expect(result.slot.comment).toBe('pizza place');

      const row = await readSlot(slotId);
      expect(row.recipeId).toBeNull();
      expect(row.numberOfServings).toBeNull();
    });

    it('transitions recipe to takeaway', async () => {
      const planId = await insertPlan();
      const recipeId = await insertRecipe('Pad Thai');
      const slotId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId,
        numberOfServings: 2,
      });

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'takeaway',
        recipeId: null,
        numberOfServings: null,
        chefUserId: null,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: null,
      });

      expect(result.slot.slotType).toBe('takeaway');
      expect(result.slot.recipeId).toBeNull();
      expect(result.slot.numberOfServings).toBeNull();
    });

    it('transitions recipe to leftovers', async () => {
      const planId = await insertPlan();
      const recipeId = await insertRecipe('Chilli');
      const slotId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId,
        numberOfServings: 6,
      });

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'leftovers',
        recipeId: null,
        numberOfServings: null,
        chefUserId: null,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: null,
      });

      expect(result.slot.slotType).toBe('leftovers');
      expect(result.slot.recipeId).toBeNull();
      expect(result.slot.numberOfServings).toBeNull();
    });

    it('transitions recipe to empty, clearing recipe, servings, chef, and comment', async () => {
      const planId = await insertPlan();
      const recipeId = await insertRecipe('Bolognese');
      const slotId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId,
        numberOfServings: 3,
        chefUserId: USER_ID,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: 'use the big pan',
      });

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'empty',
        recipeId: null,
        numberOfServings: null,
        chefUserId: null,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: null,
      });

      expect(result.slot.slotType).toBe('empty');
      expect(result.slot.recipeId).toBeNull();
      expect(result.slot.numberOfServings).toBeNull();
      expect(result.slot.chefUserId).toBeNull();
      expect(result.slot.comment).toBeNull();
    });

    it('transitions empty to eat_out without any recipe input', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'eat_out',
        recipeId: null,
        numberOfServings: null,
        chefUserId: null,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: null,
      });

      expect(result.slot.slotType).toBe('eat_out');
    });
  });

  describe('coherence validation', () => {
    it('rejects slotType=recipe with null recipeId', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          recipeId: null,
          numberOfServings: 2,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects slotType=recipe with null numberOfServings', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const recipeId = await insertRecipe('Risotto');

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          recipeId,
          numberOfServings: null,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects slotType=recipe with zero servings', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const recipeId = await insertRecipe('Pasta');

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          recipeId,
          numberOfServings: 0,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects non-recipe slotType with a recipeId set', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const recipeId = await insertRecipe('Soup');

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'eat_out',
          recipeId,
          numberOfServings: null,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('recipe pickability', () => {
    it('rejects fresh assignment of a soft-deleted recipe', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const recipeId = await insertRecipe('Gone Recipe', { isDeleted: true });

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          recipeId,
          numberOfServings: 2,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'SLOT_RECIPE_NOT_PICKABLE' },
      });
    });

    it('rejects assigning a recipe from another household', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const foreignRecipeId = await insertRecipe('Foreign', {
        householdId: OTHER_HOUSEHOLD_ID,
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          recipeId: foreignRecipeId,
          numberOfServings: 2,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'SLOT_RECIPE_CROSS_HOUSEHOLD' },
      });
    });

    it('allows editing servings on a slot whose recipe became soft-deleted', async () => {
      const planId = await insertPlan();
      const recipeId = await insertRecipe('Vanishing Pie');
      const slotId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId,
        numberOfServings: 2,
      });
      await db
        .update(recipes)
        .set({ isDeleted: true })
        .where(eq(recipes.id, recipeId));

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'recipe',
        recipeId,
        numberOfServings: 5,
        chefUserId: null,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: 'adjusted portions',
      });

      expect(result.slot.numberOfServings).toBe(5);
      expect(result.slot.recipeId).toBe(recipeId);
      expect(result.slot.recipe?.isDeleted).toBe(true);
    });

    it('rejects switching from one deleted recipe to a different deleted recipe', async () => {
      const planId = await insertPlan();
      const recipeA = await insertRecipe('A', { isDeleted: true });
      const recipeB = await insertRecipe('B', { isDeleted: true });
      const slotId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId: recipeA,
        numberOfServings: 2,
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          recipeId: recipeB,
          numberOfServings: 2,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'SLOT_RECIPE_NOT_PICKABLE' },
      });
    });
  });

  describe('chef validation', () => {
    it('rejects an unknown chef user', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'eat_out',
          recipeId: null,
          numberOfServings: null,
          chefUserId: 'bogus-user-id',
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'SLOT_CHEF_NOT_FOUND' },
      });
    });

    it('accepts a known chef user', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'eat_out',
        recipeId: null,
        numberOfServings: null,
        chefUserId: OTHER_USER_ID,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: null,
      });
      expect(result.slot.chefUserId).toBe(OTHER_USER_ID);
    });
  });

  describe('scope and auth', () => {
    it('returns NOT_FOUND for a slot in another households plan', async () => {
      const foreignPlanId = await insertPlan({
        householdId: OTHER_HOUSEHOLD_ID,
      });
      const foreignSlotId = await insertSlot(foreignPlanId);

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId: foreignSlotId,
          slotType: 'eat_out',
          recipeId: null,
          numberOfServings: null,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        cause: { code: 'SLOT_NOT_FOUND' },
      });

      const untouched = await readSlot(foreignSlotId);
      expect(untouched.slotType).toBe('empty');
    });

    it('returns NOT_FOUND for a non-existent slot', async () => {
      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId: 999_999,
          slotType: 'empty',
          recipeId: null,
          numberOfServings: null,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        cause: { code: 'SLOT_NOT_FOUND' },
      });
    });

    it('rejects unauthenticated callers', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);

      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'empty',
          recipeId: null,
          numberOfServings: null,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('base-cook fields', () => {
    async function insertBaseRecipe(
      name: string,
      options: { isDeleted?: boolean; householdId?: string } = {},
    ): Promise<number> {
      const id = await insertRecipe(name, options);
      await db.update(recipes).set({ isBase: true }).where(eq(recipes.id, id));
      return id;
    }

    it('round-trips cooksBaseRecipeId and cooksBaseServings on a recipe slot', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const mealRecipeId = await insertRecipe('Tofu Bowl');
      const baseRecipeId = await insertBaseRecipe('Curry Base');

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'recipe',
        recipeId: mealRecipeId,
        numberOfServings: 4,
        chefUserId: null,
        cooksBaseRecipeId: baseRecipeId,
        cooksBaseServings: 8,
        comment: null,
      });

      expect(result.slot.cooksBaseRecipeId).toBe(baseRecipeId);
      expect(result.slot.cooksBaseServings).toBe(8);

      const row = await readSlot(slotId);
      expect(row.cooksBaseRecipeId).toBe(baseRecipeId);
      expect(row.cooksBaseServings).toBe(8);
    });

    it('clears base-cook fields when both are set to null', async () => {
      const planId = await insertPlan();
      const mealRecipeId = await insertRecipe('Tofu Bowl');
      const baseRecipeId = await insertBaseRecipe('Curry Base');
      const slotId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId: mealRecipeId,
        numberOfServings: 4,
        cooksBaseRecipeId: baseRecipeId,
        cooksBaseServings: 8,
      });

      const caller = createCaller(makeContext());
      await caller.slots.update({
        slotId,
        slotType: 'recipe',
        recipeId: mealRecipeId,
        numberOfServings: 4,
        chefUserId: null,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: null,
      });

      const row = await readSlot(slotId);
      expect(row.cooksBaseRecipeId).toBeNull();
      expect(row.cooksBaseServings).toBeNull();
    });

    it('rejects setting one of cooksBaseRecipeId / cooksBaseServings without the other', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const mealRecipeId = await insertRecipe('Tofu Bowl');
      const baseRecipeId = await insertBaseRecipe('Curry Base');

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          recipeId: mealRecipeId,
          numberOfServings: 4,
          chefUserId: null,
          cooksBaseRecipeId: baseRecipeId,
          cooksBaseServings: null,
          comment: null,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects cooksBaseRecipeId pointing at a non-base recipe', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const mealRecipeId = await insertRecipe('Tofu Bowl');
      const notABaseId = await insertRecipe('Just A Meal');

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          recipeId: mealRecipeId,
          numberOfServings: 4,
          chefUserId: null,
          cooksBaseRecipeId: notABaseId,
          cooksBaseServings: 8,
          comment: null,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'SLOT_BASE_NOT_BASE' },
      });
    });

    it('rejects cooksBaseRecipeId from another household', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const mealRecipeId = await insertRecipe('Tofu Bowl');
      const foreignBaseId = await insertBaseRecipe('Foreign Base', {
        householdId: OTHER_HOUSEHOLD_ID,
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          recipeId: mealRecipeId,
          numberOfServings: 4,
          chefUserId: null,
          cooksBaseRecipeId: foreignBaseId,
          cooksBaseServings: 8,
          comment: null,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'SLOT_BASE_CROSS_HOUSEHOLD' },
      });
    });

    it('rejects cooksBaseRecipeId pointing at a soft-deleted base when changing it', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const mealRecipeId = await insertRecipe('Tofu Bowl');
      const deletedBaseId = await insertBaseRecipe('Gone Base', {
        isDeleted: true,
      });

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'recipe',
          recipeId: mealRecipeId,
          numberOfServings: 4,
          chefUserId: null,
          cooksBaseRecipeId: deletedBaseId,
          cooksBaseServings: 8,
          comment: null,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'SLOT_BASE_NOT_PICKABLE' },
      });
    });

    it('allows editing servings on a slot whose base recipe became soft-deleted', async () => {
      const planId = await insertPlan();
      const mealRecipeId = await insertRecipe('Tofu Bowl');
      const baseRecipeId = await insertBaseRecipe('Vanishing Base');
      const slotId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId: mealRecipeId,
        numberOfServings: 4,
        cooksBaseRecipeId: baseRecipeId,
        cooksBaseServings: 8,
      });
      await db
        .update(recipes)
        .set({ isDeleted: true })
        .where(eq(recipes.id, baseRecipeId));

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'recipe',
        recipeId: mealRecipeId,
        numberOfServings: 4,
        chefUserId: null,
        cooksBaseRecipeId: baseRecipeId,
        cooksBaseServings: 12,
        comment: null,
      });

      expect(result.slot.cooksBaseServings).toBe(12);
      expect(result.slot.cooksBaseRecipeId).toBe(baseRecipeId);
    });

    it('rejects setting cooksBaseRecipeId on a non-recipe slot', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const baseRecipeId = await insertBaseRecipe('Curry Base');

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.update({
          slotId,
          slotType: 'eat_out',
          recipeId: null,
          numberOfServings: null,
          chefUserId: null,
          cooksBaseRecipeId: baseRecipeId,
          cooksBaseServings: 8,
          comment: null,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('relocate', () => {
    it('moves a populated source onto an empty dest (source becomes empty)', async () => {
      const planId = await insertPlan();
      const recipeId = await insertRecipe('Lentil Curry');
      const sourceId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId,
        numberOfServings: 4,
        chefUserId: USER_ID,
        comment: 'source comment',
      });
      const destId = await insertSlot(planId, { occasionId: secondOccasionId });

      const caller = createCaller(makeContext());
      const result = await caller.slots.relocate({
        sourceSlotId: sourceId,
        destSlotId: destId,
      });

      expect(result.sourceSlot.slotType).toBe('empty');
      expect(result.sourceSlot.recipeId).toBeNull();
      expect(result.sourceSlot.numberOfServings).toBeNull();
      expect(result.sourceSlot.chefUserId).toBeNull();
      expect(result.sourceSlot.comment).toBeNull();
      expect(result.destSlot.slotType).toBe('recipe');
      expect(result.destSlot.recipeId).toBe(recipeId);
      expect(result.destSlot.numberOfServings).toBe(4);
      expect(result.destSlot.chefUserId).toBe(USER_ID);
      expect(result.destSlot.comment).toBe('source comment');

      const sourceRow = await readSlot(sourceId);
      const destRow = await readSlot(destId);
      expect(sourceRow.slotType).toBe('empty');
      expect(destRow.slotType).toBe('recipe');
      expect(destRow.recipeId).toBe(recipeId);
    });

    it('swaps two populated slots, exchanging recipe / servings / chef / comment / cooksBase*', async () => {
      const planId = await insertPlan();
      const sourceRecipe = await insertRecipe('Source Recipe');
      const destRecipe = await insertRecipe('Dest Recipe');
      const sourceId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId: sourceRecipe,
        numberOfServings: 2,
        chefUserId: USER_ID,
        comment: 'src',
      });
      const destId = await insertSlot(planId, {
        occasionId: secondOccasionId,
        slotType: 'recipe',
        recipeId: destRecipe,
        numberOfServings: 5,
        chefUserId: null,
        comment: 'dst',
      });

      const caller = createCaller(makeContext());
      const result = await caller.slots.relocate({
        sourceSlotId: sourceId,
        destSlotId: destId,
      });

      expect(result.sourceSlot.recipeId).toBe(destRecipe);
      expect(result.sourceSlot.numberOfServings).toBe(5);
      expect(result.sourceSlot.chefUserId).toBeNull();
      expect(result.sourceSlot.comment).toBe('dst');
      expect(result.destSlot.recipeId).toBe(sourceRecipe);
      expect(result.destSlot.numberOfServings).toBe(2);
      expect(result.destSlot.chefUserId).toBe(USER_ID);
      expect(result.destSlot.comment).toBe('src');
    });

    it('rejects a relocate across different plans with FORBIDDEN', async () => {
      const planA = await insertPlan();
      const planB = await insertPlan();
      const recipeId = await insertRecipe('A Recipe');
      const sourceId = await insertSlot(planA, {
        slotType: 'recipe',
        recipeId,
        numberOfServings: 2,
      });
      const destId = await insertSlot(planB);

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.relocate({ sourceSlotId: sourceId, destSlotId: destId }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const sourceRow = await readSlot(sourceId);
      expect(sourceRow.slotType).toBe('recipe');
      expect(sourceRow.recipeId).toBe(recipeId);
    });

    it("rejects a relocate where one slot is in another household's plan", async () => {
      const planId = await insertPlan();
      const otherPlanId = await insertPlan({ householdId: OTHER_HOUSEHOLD_ID });
      const recipeId = await insertRecipe('Foreign Plan');
      const sourceId = await insertSlot(planId, {
        slotType: 'recipe',
        recipeId,
        numberOfServings: 2,
      });
      const destId = await insertSlot(otherPlanId);

      const caller = createCaller(makeContext());
      await expect(
        caller.slots.relocate({ sourceSlotId: sourceId, destSlotId: destId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const sourceRow = await readSlot(sourceId);
      expect(sourceRow.slotType).toBe('recipe');
    });

    it('rejects sourceSlotId === destSlotId at the schema layer', async () => {
      const planId = await insertPlan();
      const slotId = await insertSlot(planId);
      const caller = createCaller(makeContext());
      await expect(
        caller.slots.relocate({ sourceSlotId: slotId, destSlotId: slotId }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects unauthenticated callers', async () => {
      const planId = await insertPlan();
      const sourceId = await insertSlot(planId);
      const destId = await insertSlot(planId, { occasionId: secondOccasionId });
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.slots.relocate({ sourceSlotId: sourceId, destSlotId: destId }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });
});
