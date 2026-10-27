import { TRPCError } from '@trpc/server';
import { and, eq, gte, sql } from 'drizzle-orm';

import { PLAN_MAX_RANGE_DAYS } from '../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import type { Db } from '../db/index.ts';
import { mealPlans } from '../db/schema/meal-plans.ts';
import { daysBetween, formatCivilDate, todayInLondon } from './date-utils.ts';

// The date rules for a new plan, shared by plan creation and the planning
// wizard's proposals so both refuse the same ranges with the same errors.
// At most PLAN_MAX_RANGE_DAYS, and no overlap with an active or future plan
// in the household (DEC-38). Inclusive boundary semantics: a plan ending on
// D blocks a new plan starting on D, matching the spec's `NOT (other.end <
// new.start OR other.start > new.end)` formulation. `end_date >= today`
// exempts past plans.
export async function assertNewPlanDatesAllowed(
  db: Db,
  startDate: Date,
  endDate: Date,
): Promise<void> {
  if (daysBetween(startDate, endDate) > PLAN_MAX_RANGE_DAYS) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Plan range cannot exceed ${PLAN_MAX_RANGE_DAYS.toString()} days`,
      cause: {
        code: 'PLAN_RANGE_TOO_LONG',
        maxDays: PLAN_MAX_RANGE_DAYS,
      },
    });
  }

  const conflicting = await db
    .select({ id: mealPlans.id })
    .from(mealPlans)
    .where(
      and(
        eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
        gte(mealPlans.endDate, todayInLondon()),
        sql`NOT (${mealPlans.endDate} < ${startDate} OR ${mealPlans.startDate} > ${endDate})`,
      ),
    );
  if (conflicting.length > 0) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Plan overlaps with an existing active or future plan',
      cause: {
        code: 'PLAN_DATE_OVERLAP',
        conflictingPlanIds: conflicting.map((row) => row.id),
      },
    });
  }
}

// A new plan's slots, as the wizard sends them: one per (date × occasion) in
// the range, and nothing else.
export function assertSlotsCoverRange(
  slots: readonly { date: string; occasionId: number }[],
  dates: readonly Date[],
  occasionIds: readonly number[],
): void {
  const expected = new Set(
    dates.flatMap((date) =>
      occasionIds.map((id) => `${formatCivilDate(date)}|${id.toString()}`),
    ),
  );
  const seen = new Set<string>();
  for (const slot of slots) {
    const key = `${slot.date}|${slot.occasionId.toString()}`;
    if (!expected.has(key) || seen.has(key)) {
      throw slotsDontCoverRange();
    }
    seen.add(key);
  }
  if (seen.size !== expected.size) {
    throw slotsDontCoverRange();
  }
}

function slotsDontCoverRange(): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Slots must be one per date and occasion in the range',
  });
}
