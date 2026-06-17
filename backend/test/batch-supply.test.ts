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
import { hasBaseSupply } from '../src/lib/batch-supply.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const USER_ID = 'user-batch-supply-1';

describe('hasBaseSupply', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;
  let lunchId!: number;
  let dinnerId!: number;
  let baseRecipeId!: number;
  let otherBaseRecipeId!: number;

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
    await db
      .insert(households)
      .values([{ id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" }]);
    await db.insert(users).values([
      {
        id: USER_ID,
        email: 'batch@example.com',
        name: 'Batch Tester',
        emailVerified: true,
      },
    ]);
    const occasions = await db
      .insert(mealOccasions)
      .values([{ name: 'Lunch' }, { name: 'Dinner' }])
      .returning({ id: mealOccasions.id, name: mealOccasions.name });
    const lunch = occasions.find((row) => row.name === 'Lunch');
    const dinner = occasions.find((row) => row.name === 'Dinner');
    if (!lunch || !dinner) throw new Error('expected lunch + dinner');
    lunchId = lunch.id;
    dinnerId = dinner.id;

    const bases = await db
      .insert(recipes)
      .values([
        {
          householdId: CURRENT_HOUSEHOLD_ID,
          name: 'Tomato Base',
          baseServings: 4,
          isBase: true,
          addedByUserId: USER_ID,
        },
        {
          householdId: CURRENT_HOUSEHOLD_ID,
          name: 'Curry Base',
          baseServings: 4,
          isBase: true,
          addedByUserId: USER_ID,
        },
      ])
      .returning({ id: recipes.id });
    const [primary, other] = bases;
    if (!primary || !other) throw new Error('expected two base recipes');
    baseRecipeId = primary.id;
    otherBaseRecipeId = other.id;
  });

  async function insertPlan(
    startDate: string,
    endDate: string,
  ): Promise<number> {
    const inserted = await db
      .insert(mealPlans)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        createdByUserId: USER_ID,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      })
      .returning({ id: mealPlans.id });
    const row = inserted[0];
    if (!row) throw new Error('plan insert failed');
    return row.id;
  }

  interface SlotSpec {
    planId: number;
    date: string;
    occasionId: number;
    cooksBaseRecipeId?: number;
    cooksBaseServings?: number;
  }

  async function insertSlot(spec: SlotSpec): Promise<number> {
    const inserted = await db
      .insert(mealPlanSlots)
      .values({
        planId: spec.planId,
        date: new Date(spec.date),
        occasionId: spec.occasionId,
        slotType: 'empty',
        cooksBaseRecipeId: spec.cooksBaseRecipeId ?? null,
        cooksBaseServings: spec.cooksBaseServings ?? null,
      })
      .returning({ id: mealPlanSlots.id });
    const row = inserted[0];
    if (!row) throw new Error('slot insert failed');
    return row.id;
  }

  it('reports supply when an earlier-date slot cooks the base', async () => {
    const planId = await insertPlan('2026-06-15', '2026-06-17');
    const supplyId = await insertSlot({
      planId,
      date: '2026-06-15',
      occasionId: dinnerId,
      cooksBaseRecipeId: baseRecipeId,
      cooksBaseServings: 8,
    });
    const targetId = await insertSlot({
      planId,
      date: '2026-06-17',
      occasionId: dinnerId,
    });

    const result = await hasBaseSupply(db, {
      planId,
      slotId: targetId,
      baseRecipeId,
    });
    expect(result.hasSupply).toBe(true);
    expect(result.earliestSupplySlotId).toBe(supplyId);
  });

  it('reports supply when the same-date earlier occasion (Lunch) cooks the base', async () => {
    const planId = await insertPlan('2026-06-15', '2026-06-15');
    const supplyId = await insertSlot({
      planId,
      date: '2026-06-15',
      occasionId: lunchId,
      cooksBaseRecipeId: baseRecipeId,
      cooksBaseServings: 8,
    });
    const targetId = await insertSlot({
      planId,
      date: '2026-06-15',
      occasionId: dinnerId,
    });

    const result = await hasBaseSupply(db, {
      planId,
      slotId: targetId,
      baseRecipeId,
    });
    expect(result.hasSupply).toBe(true);
    expect(result.earliestSupplySlotId).toBe(supplyId);
  });

  it('reports supply when the target slot itself cooks the base (self-supply)', async () => {
    const planId = await insertPlan('2026-06-15', '2026-06-15');
    const targetId = await insertSlot({
      planId,
      date: '2026-06-15',
      occasionId: dinnerId,
      cooksBaseRecipeId: baseRecipeId,
      cooksBaseServings: 8,
    });

    const result = await hasBaseSupply(db, {
      planId,
      slotId: targetId,
      baseRecipeId,
    });
    expect(result.hasSupply).toBe(true);
    expect(result.earliestSupplySlotId).toBe(targetId);
  });

  it('reports no supply when the only cooking slot is later', async () => {
    const planId = await insertPlan('2026-06-15', '2026-06-17');
    const targetId = await insertSlot({
      planId,
      date: '2026-06-15',
      occasionId: dinnerId,
    });
    await insertSlot({
      planId,
      date: '2026-06-17',
      occasionId: dinnerId,
      cooksBaseRecipeId: baseRecipeId,
      cooksBaseServings: 8,
    });

    const result = await hasBaseSupply(db, {
      planId,
      slotId: targetId,
      baseRecipeId,
    });
    expect(result.hasSupply).toBe(false);
  });

  it('reports no supply when the cooking slot is in a different plan', async () => {
    const planA = await insertPlan('2026-06-15', '2026-06-15');
    const planB = await insertPlan('2026-06-20', '2026-06-20');
    await insertSlot({
      planId: planA,
      date: '2026-06-15',
      occasionId: dinnerId,
      cooksBaseRecipeId: baseRecipeId,
      cooksBaseServings: 8,
    });
    const targetId = await insertSlot({
      planId: planB,
      date: '2026-06-20',
      occasionId: dinnerId,
    });

    const result = await hasBaseSupply(db, {
      planId: planB,
      slotId: targetId,
      baseRecipeId,
    });
    expect(result.hasSupply).toBe(false);
  });

  it('reports no supply when no slot cooks the target base recipe', async () => {
    const planId = await insertPlan('2026-06-15', '2026-06-17');
    await insertSlot({
      planId,
      date: '2026-06-15',
      occasionId: dinnerId,
      cooksBaseRecipeId: otherBaseRecipeId,
      cooksBaseServings: 8,
    });
    const targetId = await insertSlot({
      planId,
      date: '2026-06-17',
      occasionId: dinnerId,
    });

    const result = await hasBaseSupply(db, {
      planId,
      slotId: targetId,
      baseRecipeId,
    });
    expect(result.hasSupply).toBe(false);
  });

  it('returns the earliest supplying slot when multiple slots cook the base', async () => {
    const planId = await insertPlan('2026-06-15', '2026-06-17');
    const earliest = await insertSlot({
      planId,
      date: '2026-06-15',
      occasionId: lunchId,
      cooksBaseRecipeId: baseRecipeId,
      cooksBaseServings: 8,
    });
    await insertSlot({
      planId,
      date: '2026-06-15',
      occasionId: dinnerId,
      cooksBaseRecipeId: baseRecipeId,
      cooksBaseServings: 8,
    });
    const targetId = await insertSlot({
      planId,
      date: '2026-06-17',
      occasionId: dinnerId,
    });

    const result = await hasBaseSupply(db, {
      planId,
      slotId: targetId,
      baseRecipeId,
    });
    expect(result.earliestSupplySlotId).toBe(earliest);
  });
});
