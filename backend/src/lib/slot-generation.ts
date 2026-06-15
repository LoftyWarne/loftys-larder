import { mealPlanSlots } from '../db/schema/meal-plans.ts';
import type { Tx } from '../db/withTransaction.ts';

import { eachDateInRange } from './date-utils.ts';

// Bulk-inserts one `empty` slot per `(date × occasionId)` for the given plan
// range. The cartesian product is constructed in memory and issued as a single
// `INSERT` so the operation stays atomic when wrapped in `withTransaction`
// (cross-cutting #4) — partial slot generation would leave the plan in a
// half-populated state that the planner UI has no way to render.
//
// Caller responsibilities:
//   - Run inside an open transaction (pass the `tx` handle).
//   - Provide an already-validated date range and a non-empty occasion list.
//   - Provide `occasionIds` that already exist in `meal_occasions` (FK guards
//     us, but failing the FK after a long generation pass is a worse UX than
//     refusing earlier).
export async function generateEmptySlotsForRange(
  tx: Tx,
  planId: number,
  startDate: Date,
  endDate: Date,
  occasionIds: number[],
): Promise<number> {
  if (occasionIds.length === 0) {
    throw new Error(
      'generateEmptySlotsForRange: occasionIds must be non-empty',
    );
  }
  const dates = eachDateInRange(startDate, endDate);
  const rows = dates.flatMap((date) =>
    occasionIds.map((occasionId) => ({
      planId,
      date,
      occasionId,
      slotType: 'empty' as const,
    })),
  );
  await tx.insert(mealPlanSlots).values(rows);
  return rows.length;
}
