import pg from 'pg';

// One pool per Node process. Specs and global-setup share it.
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — e2e cannot connect to Postgres');
  }
  pool = new pg.Pool({ connectionString, max: 4 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// The display name stamped onto the e2e user (see setUserName). Specs assert
// the home greeting against it, so it lives next to the writer to stay in sync.
export const E2E_USER_NAME = 'E2E Tester';

// Better Auth creates the magic-link user with an empty `name`. The authed
// gate (authed-layout) bounces every authed route to /welcome until a name is
// set, so specs that expect to land on the app need one stamped in. Auth
// tables survive resetHouseholdData, so a single call in global-setup holds
// for the whole run.
export async function setUserName(email: string, name: string): Promise<void> {
  await getPool().query(`update users set name = $2 where email = $1`, [
    email,
    name,
  ]);
}

// Single-household constant from backend/src/config.ts. Duplicated rather than
// imported so the e2e workspace stays independent of backend source paths.
export const HOUSEHOLD_ID = '00000000-0000-4000-8000-000000000001';

// Wipe every household-scoped row between specs while leaving auth (users /
// sessions), the seeded household, and reference data untouched. RESTART
// IDENTITY keeps serial PKs deterministic across specs.
export async function resetHouseholdData(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(`
      truncate table
        shopping_list_items,
        meal_plan_slot_diners,
        meal_plan_slot_items,
        meal_plan_slots,
        meal_plans,
        recipe_method,
        recipe_ingredients,
        recipes,
        recipe_sources,
        ingredients
      restart identity cascade
    `);
  } finally {
    client.release();
  }
}

export interface CreatedRecipe {
  id: number;
  name: string;
  baseServings: number;
  isBase: boolean;
  baseRecipeId: number | null;
}

export interface IngredientSpec {
  name: string;
  quantity: string;
  unit: string;
  category: string;
  isPlant?: boolean;
}

export interface CreateRecipeSpec {
  name: string;
  baseServings: number;
  isBase?: boolean;
  baseRecipeId?: number;
  ingredients: IngredientSpec[];
}

// Insert (or reuse) an ingredient row scoped to the household. The pre-existing
// reference rows (ingredient_categories, units_of_measurement) supply the FKs.
async function ensureIngredient(
  client: pg.PoolClient,
  spec: IngredientSpec,
): Promise<number> {
  const existing = await client.query<{ id: number }>(
    `select id from ingredients
     where household_id = $1 and lower(name) = lower($2)`,
    [HOUSEHOLD_ID, spec.name],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId !== undefined) return existingId;

  const inserted = await client.query<{ id: number }>(
    `insert into ingredients (household_id, name, category_id, default_unit_id, is_plant)
     values (
       $1,
       $2,
       (select id from ingredient_categories where name = $3),
       (select id from units_of_measurement where name = $4),
       $5
     )
     returning id`,
    [HOUSEHOLD_ID, spec.name, spec.category, spec.unit, spec.isPlant ?? false],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error(`Failed to insert ingredient ${spec.name}`);
  }
  return row.id;
}

// Create a recipe + its ingredient rows in one transaction. Returns the recipe
// id so specs can build slot assignments by referring back to it.
export async function createRecipe(
  spec: CreateRecipeSpec,
): Promise<CreatedRecipe> {
  const client = await getPool().connect();
  try {
    await client.query('begin');

    const recipeInsert = await client.query<{ id: number }>(
      `insert into recipes (household_id, name, base_servings, is_base, base_recipe_id)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [
        HOUSEHOLD_ID,
        spec.name,
        spec.baseServings,
        spec.isBase ?? false,
        spec.baseRecipeId ?? null,
      ],
    );
    const recipeRow = recipeInsert.rows[0];
    if (!recipeRow) throw new Error(`Failed to insert recipe ${spec.name}`);

    for (const ingredient of spec.ingredients) {
      const ingredientId = await ensureIngredient(client, ingredient);
      await client.query(
        `insert into recipe_ingredients (recipe_id, ingredient_id, quantity)
         values ($1, $2, $3)`,
        [recipeRow.id, ingredientId, ingredient.quantity],
      );
    }

    await client.query('commit');
    return {
      id: recipeRow.id,
      name: spec.name,
      baseServings: spec.baseServings,
      isBase: spec.isBase ?? false,
      baseRecipeId: spec.baseRecipeId ?? null,
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export interface CreatedPlan {
  id: number;
  startDate: string;
  endDate: string;
  slotsByDateAndOccasion: Map<string, number>;
}

function slotKey(date: string, occasionName: string): string {
  return `${date}|${occasionName}`;
}

// Insert a plan and an empty slot for every (date, meal_occasion) in the
// range. Mirrors backend `generateEmptySlotsForRange`. The map lets specs
// look up the slot id they want to populate without an extra query.
export async function createPlan(
  startDate: string,
  endDate: string,
): Promise<CreatedPlan> {
  const client = await getPool().connect();
  try {
    await client.query('begin');

    const planInsert = await client.query<{ id: number }>(
      `insert into meal_plans (household_id, start_date, end_date)
       values ($1, $2::date, $3::date) returning id`,
      [HOUSEHOLD_ID, startDate, endDate],
    );
    const planRow = planInsert.rows[0];
    if (!planRow) throw new Error('Failed to insert meal plan');

    const occasions = await client.query<{ id: number; name: string }>(
      `select id, name from meal_occasions order by id`,
    );

    const slotsByDateAndOccasion = new Map<string, number>();

    const dates = enumerateDates(startDate, endDate);
    for (const date of dates) {
      for (const occasion of occasions.rows) {
        const slot = await client.query<{ id: number }>(
          `insert into meal_plan_slots (plan_id, date, occasion_id, slot_type)
           values ($1, $2::date, $3, 'empty') returning id`,
          [planRow.id, date, occasion.id],
        );
        const slotRow = slot.rows[0];
        if (!slotRow) throw new Error('Failed to insert slot');
        slotsByDateAndOccasion.set(slotKey(date, occasion.name), slotRow.id);
      }
    }

    await client.query('commit');
    return {
      id: planRow.id,
      startDate,
      endDate,
      slotsByDateAndOccasion,
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export interface AssignRecipeSpec {
  slotId: number;
  recipeId: number;
  numberOfServings: number;
}

// Mark a slot as a `recipe` meal and add the recipe as its eaten dish. In the
// composable-slot model (DEC-89) the dish lives in meal_plan_slot_items with
// kind='eat' rather than on the slot row.
export async function assignRecipeToSlot(
  spec: AssignRecipeSpec,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query(
      `update meal_plan_slots set slot_type = 'recipe' where id = $1`,
      [spec.slotId],
    );
    await insertSlotItem(client, {
      slotId: spec.slotId,
      recipeId: spec.recipeId,
      servings: spec.numberOfServings,
      kind: 'eat',
    });
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Add a base cooked ahead in this slot. The slot stays type='empty' — a
// cook_ahead dish contributes to the shopping list and balance without the
// slot itself being an eaten meal (DEC-89). The schema couples `eat` items to
// the `recipe` status, but `cook_ahead` items are orthogonal to slot_type.
export async function setCooksBaseOnSlot(spec: {
  slotId: number;
  cooksBaseRecipeId: number;
  cooksBaseServings: number;
}): Promise<void> {
  await insertSlotItem(getPool(), {
    slotId: spec.slotId,
    recipeId: spec.cooksBaseRecipeId,
    servings: spec.cooksBaseServings,
    kind: 'cook_ahead',
  });
}

// Append a dish to a slot, computing the next sort_order so repeated calls on
// one slot stay ordered.
async function insertSlotItem(
  db: pg.Pool | pg.PoolClient,
  item: {
    slotId: number;
    recipeId: number;
    servings: number;
    kind: 'eat' | 'cook_ahead';
  },
): Promise<void> {
  await db.query(
    `insert into meal_plan_slot_items (slot_id, recipe_id, servings, kind, sort_order)
     values (
       $1, $2, $3, $4,
       coalesce(
         (select max(sort_order) + 1 from meal_plan_slot_items where slot_id = $1),
         0
       )
     )`,
    [item.slotId, item.recipeId, item.servings, item.kind],
  );
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const out: string[] = [];
  for (
    let cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    out.push(cursor.toISOString().slice(0, 10));
  }
  return out;
}

export interface VerificationRow {
  identifier: string;
  value: string;
  expiresAt: Date;
}

// The magic-link plugin stores the raw token as `identifier` (see
// node_modules/better-auth/.../magic-link/index.mjs) and the JSON-encoded
// {email, name} payload as `value`. Filtering by email keeps us robust even
// if other verifications appear (e.g. from earlier test runs).
export async function getLatestVerificationFor(
  email: string,
): Promise<VerificationRow> {
  const rows = await getPool().query<{
    identifier: string;
    value: string;
    expires_at: Date;
  }>(
    `select identifier, value, expires_at
     from verifications
     where value::jsonb ->> 'email' = $1
     order by created_at desc
     limit 1`,
    [email],
  );
  const row = rows.rows[0];
  if (!row) {
    throw new Error(`No verification row found for ${email}`);
  }
  return {
    identifier: row.identifier,
    value: row.value,
    expiresAt: row.expires_at,
  };
}
