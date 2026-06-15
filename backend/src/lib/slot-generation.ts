import { mealPlanSlots } from '../db/schema/meal-plans.ts';
import type { Tx } from '../db/withTransaction.ts';

import { eachDateInRange } from './date-utils.ts';

// Bulk-inserts one `empty` slot per `(date × occasionId)` for the given dates.
// The cartesian product is constructed in memory and issued as a single
// `INSERT` so the operation stays atomic when wrapped in `withTransaction`
// (cross-cutting #4) — partial slot generation would leave the plan in a
// half-populated state that the planner UI has no way to render.
//
// Caller responsibilities:
//   - Run inside an open transaction (pass the `tx` handle).
//   - Provide an already-validated date list and a non-empty occasion list.
//   - Provide `occasionIds` that already exist in `meal_occasions` (FK guards
//     us, but failing the FK after a long generation pass is a worse UX than
//     refusing earlier).
//   - Provide dates that do not already have slots for the plan; the unique
//     index `(plan_id, date, occasion_id)` would otherwise raise.
export async function generateEmptySlotsForDates(
  tx: Tx,
  planId: number,
  dates: Date[],
  occasionIds: number[],
): Promise<number> {
  if (occasionIds.length === 0) {
    throw new Error(
      'generateEmptySlotsForDates: occasionIds must be non-empty',
    );
  }
  if (dates.length === 0) {
    return 0;
  }
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

// Contiguous-range convenience used by `plans.create`. Range edits
// (`plans.updateRange`) call `generateEmptySlotsForDates` directly because
// the added dates are the diff between two ranges, not a contiguous span.
export async function generateEmptySlotsForRange(
  tx: Tx,
  planId: number,
  startDate: Date,
  endDate: Date,
  occasionIds: number[],
): Promise<number> {
  return generateEmptySlotsForDates(
    tx,
    planId,
    eachDateInRange(startDate, endDate),
    occasionIds,
  );
}
