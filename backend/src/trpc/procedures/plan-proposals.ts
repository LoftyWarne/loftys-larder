import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  proposePlanInputSchema,
  proposePlanResultSchema,
  type DomainErrorCode,
  type PlanProposal,
  type ProposePlanResult,
} from '../../../../shared/src/index.ts';
import type { Db } from '../../db/index.ts';
import { recipes } from '../../db/schema/recipes.ts';
import { mealOccasions } from '../../db/schema/reference.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { eachDateInRange, parseCivilDate } from '../../lib/date-utils.ts';
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
import {
  assertNewPlanDatesAllowed,
  assertSlotsCoverRange,
} from '../../lib/plan-dates.ts';
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
import { assertDinersExist } from '../../lib/slot-writes.ts';
import { protectedProcedure, router } from '../init.ts';

// Set at FEAT-74 kick-off, as import's (DEC-104), under Cloudflare's
// 100-second origin limit (DEC-72), with the client's one retry inside it.
export const MEAL_PLAN_TIMEOUT_MS = 75_000;

export const MEAL_PLAN_FEATURE = 'meal-plan';

type TryAgainReason = 'timeout' | 'unavailable' | 'invalid_result';

export const planProposalsRouter = router({
  // Proposes meals for a new plan's slots that aren't fixed (DEC-117). Writes
  // nothing: the proposal lives in the wizard's state until Apply. The
  // library is read, and the model called, outside any transaction.
  propose: protectedProcedure
    .input(proposePlanInputSchema)
    .output(proposePlanResultSchema)
    .mutation(async ({ ctx, input, signal }): Promise<ProposePlanResult> => {
      const { planner, healthScoreSince, allowProposal } = ctx.mealPlan;
      const startDate = parseCivilDate(input.startDate);
      const endDate = parseCivilDate(input.endDate);

      // The cheap checks: none of these call the model or count towards the
      // limit.
      await assertNewPlanDatesAllowed(ctx.db, startDate, endDate);
      const occasionNames = await loadOccasionNames(ctx.db);
      assertSlotsCoverRange(input.slots, eachDateInRange(startDate, endDate), [
        ...occasionNames.keys(),
      ]);
      await assertDinersExist(
        ctx.db,
        input.slots.flatMap((slot) => slot.dinerUserIds),
      );

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
        return await withDishDetails(ctx.db, {
          slots: slots.filter((slot) => slot.fixed === null).map(emptySlot),
          summary: '',
          dropped: 0,
        });
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
            feature: MEAL_PLAN_FEATURE,
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
      return await withDishDetails(ctx.db, proposal);
    }),
});

async function loadOccasionNames(db: Db): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: mealOccasions.id, name: mealOccasions.name })
    .from(mealOccasions)
    .orderBy(asc(mealOccasions.id));
  return new Map(rows.map((row) => [row.id, row.name]));
}

// Adds each dish's recipe fields for Plan Review to show. Every recipe is in
// the household: the normaliser keeps only pickable ones.
async function withDishDetails(
  db: Db,
  proposal: PlanProposal,
): Promise<ProposePlanResult> {
  const ids = [
    ...new Set(
      proposal.slots.flatMap((slot) => slot.items.map((item) => item.recipeId)),
    ),
  ];
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({
            id: recipes.id,
            name: recipes.name,
            imageUrl: recipes.imageUrl,
            isBase: recipes.isBase,
            baseRecipeId: recipes.baseRecipeId,
          })
          .from(recipes)
          .where(
            and(
              inArray(recipes.id, ids),
              eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
            ),
          );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    ...proposal,
    slots: proposal.slots.map((slot) => ({
      ...slot,
      items: slot.items.flatMap((item) => {
        const recipe = byId.get(item.recipeId);
        if (!recipe) return [];
        return [
          {
            ...item,
            recipeName: recipe.name,
            recipeImageUrl: recipe.imageUrl,
            isBase: recipe.isBase,
            baseRecipeId: recipe.baseRecipeId,
          },
        ];
      }),
    })),
  };
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
