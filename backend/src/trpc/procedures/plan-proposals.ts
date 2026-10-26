import { TRPCError } from '@trpc/server';
import { asc, inArray } from 'drizzle-orm';

import {
  planProposalSchema,
  proposePlanInputSchema,
  type DomainErrorCode,
  type PlanProposal,
  type ProposePlanInput,
} from '../../../../shared/src/index.ts';
import type { Db } from '../../db/index.ts';
import { users } from '../../db/schema/auth.ts';
import { mealOccasions } from '../../db/schema/reference.ts';
import {
  eachDateInRange,
  formatCivilDate,
  parseCivilDate,
} from '../../lib/date-utils.ts';
import {
  MealPlannerRequestError,
  MealPlannerTimeoutError,
  MealPlannerUnavailableError,
  type MealPlannerUsage,
  type MealPlanning,
} from '../../lib/meal-planner/types.ts';
import {
  logModelUsage,
  type ModelUsageDetails,
} from '../../lib/model-features/usage-log.ts';
import { assertNewPlanDatesAllowed } from '../../lib/plan-dates.ts';
import {
  emptySlot,
  normalisePlanProposal,
  type ProposalSlotContext,
} from '../../lib/plan-proposal/normalise.ts';
import {
  buildMealPlanRequest,
  loadPlannerLibrary,
  slotHeadcount,
} from '../../lib/plan-proposal/request.ts';
import { protectedProcedure, router } from '../init.ts';

// Set at FEAT-74 kick-off, as import's (DEC-104), under Cloudflare's
// 100-second origin limit (DEC-72), with the client's one retry inside it.
export const MEAL_PLAN_TIMEOUT_MS = 75_000;

const FEATURE = 'meal-plan';

type TryAgainReason = 'timeout' | 'unavailable' | 'invalid_result';

export const planProposalsRouter = router({
  // Proposes meals for a new plan's slots that aren't fixed (DEC-117). Writes
  // nothing: the proposal lives in the wizard's state until Apply. The
  // library is read, and the model called, outside any transaction.
  propose: protectedProcedure
    .input(proposePlanInputSchema)
    .output(planProposalSchema)
    .mutation(async ({ ctx, input, signal }): Promise<PlanProposal> => {
      const { planner, healthScoreSince, allowProposal } = ctx.mealPlan;
      const startDate = parseCivilDate(input.startDate);
      const endDate = parseCivilDate(input.endDate);

      // The cheap checks: none of these call the model or count towards the
      // limit.
      await assertNewPlanDatesAllowed(ctx.db, startDate, endDate);
      const occasionNames = await loadOccasionNames(ctx.db);
      assertSlotsCoverRange(input, eachDateInRange(startDate, endDate), [
        ...occasionNames.keys(),
      ]);
      await assertDinersExist(ctx.db, input);

      const library = await loadPlannerLibrary(ctx.db, {
        startDate,
        healthScoreSince,
      });
      if (library.length === 0) {
        throw domainError(
          'UNPROCESSABLE_CONTENT',
          'MEAL_PLAN_NO_RECIPES',
          'There are no recipes to plan from',
        );
      }
      const pickableRecipeIds = new Set(library.map((recipe) => recipe.id));
      for (const slot of input.slots) {
        if (
          slot.fixed?.kind === 'recipe' &&
          !pickableRecipeIds.has(slot.fixed.recipeId)
        ) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A fixed recipe is not pickable',
            cause: {
              code: 'SLOT_RECIPE_NOT_PICKABLE',
              recipeId: slot.fixed.recipeId,
            },
          });
        }
      }

      const request = buildMealPlanRequest(input, library, occasionNames);
      const slots: ProposalSlotContext[] = input.slots.map((slot, index) => ({
        date: slot.date,
        occasionId: slot.occasionId,
        occasion: request.slots[index]?.occasion ?? '',
        headcount: slotHeadcount(slot),
        fixed: slot.fixed,
      }));
      // Every slot is fixed or has nobody eating: nothing to ask the model.
      if (!slots.some((slot) => slot.fixed === null && slot.headcount > 0)) {
        return {
          slots: slots.filter((slot) => slot.fixed === null).map(emptySlot),
          summary: '',
          dropped: 0,
        };
      }

      const verdict = await allowProposal();
      if (!verdict.allowed) {
        throw domainError(
          'TOO_MANY_REQUESTS',
          'MEAL_PLAN_RATE_LIMITED',
          'Too many plan proposals for now',
          { retryAfterSeconds: verdict.retryAfterSeconds },
        );
      }

      const timeout = AbortSignal.timeout(MEAL_PLAN_TIMEOUT_MS);
      const proposeSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      const startedAt = performance.now();
      // Metadata only: never the Brief, the note, reasons, the summary or
      // recipe names (DEC-117).
      const logUsage = (
        outcome: string,
        usage: MealPlannerUsage | null,
        details: ModelUsageDetails = {},
      ) => {
        logModelUsage(
          ctx.log,
          {
            feature: FEATURE,
            adapter: planner.adapter,
            model: usage?.model ?? planner.model,
            inputTokens: usage?.inputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
            latencyMs: Math.round(performance.now() - startedAt),
            outcome,
          },
          {
            slotCount: input.slots.length,
            fixedCount: input.slots.filter(
              (slot) => slot.fixed !== null && slot.fixed.kind !== 'empty',
            ).length,
            libraryCount: library.length,
            briefLength: request.brief?.length ?? 0,
            rerun: input.previous !== null,
            ...details,
          },
        );
      };

      let planning: MealPlanning;
      try {
        planning = await planner.propose(request, proposeSignal);
      } catch (error) {
        if (error instanceof MealPlannerTimeoutError) {
          logUsage('MEAL_PLAN_TRY_AGAIN', null, { reason: 'timeout' });
          throw tryAgain('timeout');
        }
        if (error instanceof MealPlannerUnavailableError) {
          logUsage('MEAL_PLAN_TRY_AGAIN', null, {
            reason: 'unavailable',
            providerStatus: error.status,
          });
          throw tryAgain('unavailable');
        }
        // Our request was wrong, so the provider's reason is kept for
        // whoever fixes it. It reaches Sentry with the domain code only.
        if (error instanceof MealPlannerRequestError) {
          logUsage('MEAL_PLAN_REQUEST_REJECTED', null, {
            providerStatus: error.status,
            providerErrorType: error.providerErrorType,
            providerMessage: error.providerMessage,
            providerRequestId: error.providerRequestId,
          });
          throw domainError(
            'INTERNAL_SERVER_ERROR',
            'MEAL_PLAN_REQUEST_REJECTED',
            'The meal planner refused the request',
          );
        }
        throw error;
      }

      const { outcome, usage } = planning;
      if (outcome.kind === 'refused') {
        logUsage('MEAL_PLAN_NOT_PROPOSED', usage);
        throw domainError(
          'UNPROCESSABLE_CONTENT',
          'MEAL_PLAN_NOT_PROPOSED',
          'A plan couldn’t be proposed',
        );
      }
      const proposal = normalisePlanProposal(outcome.candidate, {
        slots,
        pickableRecipeIds,
      });
      if (!proposal) {
        logUsage('MEAL_PLAN_TRY_AGAIN', usage, { reason: 'invalid_result' });
        throw tryAgain('invalid_result');
      }
      logUsage('proposed', usage, { dropped: proposal.dropped });
      return proposal;
    }),
});

async function loadOccasionNames(db: Db): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: mealOccasions.id, name: mealOccasions.name })
    .from(mealOccasions)
    .orderBy(asc(mealOccasions.id));
  return new Map(rows.map((row) => [row.id, row.name]));
}

// One slot per (date × occasion) in the range, and nothing else.
function assertSlotsCoverRange(
  input: ProposePlanInput,
  dates: Date[],
  occasionIds: number[],
): void {
  const expected = new Set(
    dates.flatMap((date) =>
      occasionIds.map((id) => `${formatCivilDate(date)}|${id.toString()}`),
    ),
  );
  const seen = new Set<string>();
  for (const slot of input.slots) {
    const key = `${slot.date}|${slot.occasionId.toString()}`;
    if (!expected.has(key) || seen.has(key)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Slots must be one per date and occasion in the range',
      });
    }
    seen.add(key);
  }
  if (seen.size !== expected.size) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Slots must be one per date and occasion in the range',
    });
  }
}

// Diners are counted, never sent, but checked as the slot editor checks them.
async function assertDinersExist(
  db: Db,
  input: ProposePlanInput,
): Promise<void> {
  const ids = [...new Set(input.slots.flatMap((slot) => slot.dinerUserIds))];
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, ids));
  if (rows.length !== ids.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Diner user not found',
      cause: { code: 'SLOT_DINER_NOT_FOUND' },
    });
  }
}

// Timeouts, outages and unusable results are server-side failures, so they
// reach Sentry, with the domain code and reason only (DEC-104).
function tryAgain(reason: TryAgainReason): TRPCError {
  const code =
    reason === 'timeout'
      ? 'GATEWAY_TIMEOUT'
      : reason === 'unavailable'
        ? 'SERVICE_UNAVAILABLE'
        : 'BAD_GATEWAY';
  return domainError(code, 'MEAL_PLAN_TRY_AGAIN', 'The plan didn’t work', {
    reason,
  });
}

function domainError(
  code: TRPCError['code'],
  domainCode: DomainErrorCode,
  message: string,
  metadata: Record<string, unknown> = {},
): TRPCError {
  return new TRPCError({
    code,
    message,
    cause: { code: domainCode, ...metadata },
  });
}
