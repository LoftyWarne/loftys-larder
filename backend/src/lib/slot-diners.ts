import { asc, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from '../db/schema/index.ts';
import { mealPlanSlotDiners } from '../db/schema/meal-plans.ts';
import type { Tx } from '../db/withTransaction.ts';

type DbHandle = NodePgDatabase<typeof schema> | Tx;

// Loads the named household members eating each of the given slots — the "who"
// behind the planner headcount. Returned as a map keyed by slot id; slots with
// no named diners are simply absent. Ordered by `(slot, user)` so each slot's
// ids come back stable.
export async function loadSlotDiners(
  db: DbHandle,
  slotIds: readonly number[],
): Promise<Map<number, string[]>> {
  const bySlot = new Map<number, string[]>();
  if (slotIds.length === 0) return bySlot;

  const rows = await db
    .select({
      slotId: mealPlanSlotDiners.slotId,
      userId: mealPlanSlotDiners.userId,
    })
    .from(mealPlanSlotDiners)
    .where(inArray(mealPlanSlotDiners.slotId, [...slotIds]))
    .orderBy(asc(mealPlanSlotDiners.slotId), asc(mealPlanSlotDiners.userId));

  for (const row of rows) {
    const list = bySlot.get(row.slotId);
    if (list) list.push(row.userId);
    else bySlot.set(row.slotId, [row.userId]);
  }
  return bySlot;
}
