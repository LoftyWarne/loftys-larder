import { and, eq, isNotNull } from 'drizzle-orm';

import type {
  StapleState,
  StorageLocation,
} from '../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import { ingredients } from '../db/schema/ingredients.ts';
import { unitsOfMeasurement } from '../db/schema/reference.ts';
import type { Tx } from '../db/withTransaction.ts';

// Staples (DEC-118): a state on an ingredient, kept in one Storage location,
// never a Stock item. The state is household-wide, so every plan's list sees
// the same one.

export interface Staple {
  ingredientId: number;
  name: string;
  unitId: number;
  unitName: string;
  state: StapleState;
  location: StorageLocation;
}

export function needsRestock(state: StapleState): boolean {
  return state === 'running_low' || state === 'out';
}

export async function loadStaples(tx: Tx): Promise<Map<number, Staple>> {
  const rows = await tx
    .select({
      ingredientId: ingredients.id,
      name: ingredients.name,
      unitId: unitsOfMeasurement.id,
      unitName: unitsOfMeasurement.name,
      state: ingredients.stapleState,
      location: ingredients.stapleLocation,
    })
    .from(ingredients)
    .innerJoin(
      unitsOfMeasurement,
      eq(unitsOfMeasurement.id, ingredients.defaultUnitId),
    )
    .where(
      and(
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
        isNotNull(ingredients.stapleState),
      ),
    );

  const staples = new Map<number, Staple>();
  for (const row of rows) {
    if (row.state === null || row.location === null) continue;
    staples.set(row.ingredientId, {
      ingredientId: row.ingredientId,
      name: row.name,
      unitId: row.unitId,
      unitName: row.unitName,
      state: row.state,
      location: row.location,
    });
  }
  return staples;
}

// Locks the ingredient's row and reads its Staple state, null when it isn't a
// Staple. The lock serialises ticks on two plans' lists, so each stores the
// state it really replaced.
export async function lockStapleState(
  tx: Tx,
  ingredientId: number,
): Promise<StapleState | null> {
  const [row] = await tx
    .select({ state: ingredients.stapleState })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.id, ingredientId),
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .for('no key update');
  return row?.state ?? null;
}

// The one side effect a tick has (DEC-118). Ticking a running-low or out
// Staple restocks it and returns the state it replaced, to keep on the check
// row. Ticking one already in stock keeps whatever was stored, so a replayed
// tick doesn't forget. Unticking puts the stored state back. Returns what the
// check row should now hold.
export async function applyStapleTick(
  tx: Tx,
  ingredientId: number,
  state: StapleState,
  isChecked: boolean,
  storedReplaced: StapleState | null,
): Promise<StapleState | null> {
  if (isChecked) {
    if (!needsRestock(state)) return storedReplaced;
    await setState(tx, ingredientId, 'in_stock');
    return state;
  }
  if (storedReplaced !== null) {
    await setState(tx, ingredientId, storedReplaced);
  }
  return null;
}

async function setState(
  tx: Tx,
  ingredientId: number,
  state: StapleState,
): Promise<void> {
  await tx
    .update(ingredients)
    .set({ stapleState: state })
    .where(
      and(
        eq(ingredients.id, ingredientId),
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
        isNotNull(ingredients.stapleState),
      ),
    );
}
