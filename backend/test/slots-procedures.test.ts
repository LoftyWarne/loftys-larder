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
    if (!first) throw new Error('expected occasion');
    occasionId = first.id;
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
        comment: 'leftover marinade',
      });

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'eat_out',
        recipeId: null,
        numberOfServings: null,
        chefUserId: USER_ID,
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
        comment: 'use the big pan',
      });

      const caller = createCaller(makeContext());
      const result = await caller.slots.update({
        slotId,
        slotType: 'empty',
        recipeId: null,
        numberOfServings: null,
        chefUserId: null,
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
          comment: null,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('base-cook fields are untouched', () => {
    it('preserves any pre-existing cooks_base_* values through state transitions', async () => {
      const planId = await insertPlan();
      const baseRecipeId = await insertRecipe('Tomato Base');
      // The schema permits cooks_base_* alongside any slot type so long as
      // the joint-set CHECK holds. FEAT-32 will validate is_base on the
      // procedure layer; here we just confirm slots.update leaves the columns
      // alone — they survive even when the slot transitions through states.
      await db
        .update(recipes)
        .set({ isBase: true })
        .where(eq(recipes.id, baseRecipeId));
      const slotId = await insertSlot(planId, {
        slotType: 'empty',
        cooksBaseRecipeId: baseRecipeId,
        cooksBaseServings: 8,
      });

      const caller = createCaller(makeContext());
      await caller.slots.update({
        slotId,
        slotType: 'eat_out',
        recipeId: null,
        numberOfServings: null,
        chefUserId: null,
        comment: null,
      });

      const row = await readSlot(slotId);
      expect(row.cooksBaseRecipeId).toBe(baseRecipeId);
      expect(row.cooksBaseServings).toBe(8);
    });
  });
});
