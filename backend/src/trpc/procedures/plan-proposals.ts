import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  compareSlotOrder,
  proposePlanInputSchema,
  proposePlanResultSchema,
  proposeSlotInputSchema,
  proposeSlotResultSchema,
  type DomainErrorCode,
  type MealPlanRecipe,
  type MealPlanRequest,
  type PlanProposal,
  type ProposePlanInput,
  type ProposePlanResult,
  type ProposeSlotInput,
  type ProposeSlotResult,
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
  type MealPlannerOutcome,
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
  cookedBefore,
  emptySlot,
  normalisePlanProposal,
  normaliseSlotSuggestion,
  type ProposalSlotContext,
} from '../../lib/plan-proposal/normalise.ts';
import {
  buildMealPlanRequest,
  buildMealPlanSlotRequest,
  loadPlannerLibrary,
  slotHeadcount,
} from '../../lib/plan-proposal/request.ts';
import { assertDinersExist } from '../../lib/slot-writes.ts';
import type { AppContext } from '../context.ts';
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
      const { planner, allowProposal } = ctx.mealPlan;
      const { library, pickableRecipeIds, occasionNames } =
        await checkPlanInput(ctx, input);

      const request = buildMealPlanRequest(input, library, occasionNames);
      const slots = slotContexts(input.slots, request.slots);
      // Nothing to ask the model when every slot is fixed or has nobody
      // eating, unless an open slot nobody eats at could cook a fixed
      // variation's base before it's needed.
      const needsDish = slots.some(
        (slot) => slot.fixed === null && slot.headcount > 0,
      );
      const canCookBase = request.basesToCook.some(({ neededBy }) =>
        slots.some(
          (slot) =>
            slot.fixed === null &&
            slot.headcount === 0 &&
            compareSlotOrder(
              { date: slot.date, occasionName: slot.occasion },
              { date: neededBy.date, occasionName: neededBy.occasion },
            ) < 0,
        ),
      );
      if (!needsDish && !canCookBase) {
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

      const { outcome, logUsage } = await callPlanner(
        ctx,
        (plannerSignal) => planner.propose(request, plannerSignal),
        signal,
        {
          ...inputDetails(input, library.length, request.brief),
          rerun: input.previous !== null,
        },
      );
      const proposal = normalisePlanProposal(outcome.candidate, {
        slots,
        pickableRecipeIds,
      });
      if (!proposal) {
        logUsage('MEAL_PLAN_TRY_AGAIN', { reason: 'invalid_result' });
        throw tryAgain('invalid_result');
      }
      logUsage('proposed', { dropped: proposal.dropped });
      return await withDishDetails(ctx.db, proposal);
    }),

  // Suggest again for one slot of a Plan Proposal in review (DEC-117). The
  // proposal as it stands is context for balance, variety and leftovers.
  // Writes nothing, and is limited apart from whole-plan proposals.
  proposeSlot: protectedProcedure
    .input(proposeSlotInputSchema)
    .output(proposeSlotResultSchema)
    .mutation(async ({ ctx, input, signal }): Promise<ProposeSlotResult> => {
      const { planner, allowSlotSuggestion } = ctx.mealPlan;
      const { library, pickableRecipeIds, occasionNames } =
        await checkPlanInput(ctx, input);

      const request = buildMealPlanSlotRequest(input, library, occasionNames);
      const slots = slotContexts(input.slots, request.slots);
      const target = slots.find(
        (slot) =>
          slot.date === input.target.date &&
          slot.occasionId === input.target.occasionId,
      );
      if (target?.fixed !== null) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The slot to suggest for must be in the plan and not fixed',
        });
      }

      const verdict = await allowSlotSuggestion();
      if (!verdict.allowed) {
        throw domainError(
          'TOO_MANY_REQUESTS',
          'MEAL_PLAN_SLOT_RATE_LIMITED',
          'Too many single-meal suggestions for now',
          { retryAfterSeconds: verdict.retryAfterSeconds },
        );
      }

      const { outcome, logUsage } = await callPlanner(
        ctx,
        (plannerSignal) => planner.proposeSlot(request, plannerSignal),
        signal,
        {
          ...inputDetails(input, library.length, request.brief),
          singleSlot: true,
          avoidCount: request.avoidRecipeIds.length,
        },
      );
      const slot = normaliseSlotSuggestion(outcome.candidate, {
        slot: target,
        cookedEarlier: cookedBefore(target, slots, input.current),
        pickableRecipeIds,
        avoidRecipeIds: new Set(request.avoidRecipeIds),
      });
      if (!slot) {
        logUsage('MEAL_PLAN_TRY_AGAIN', { reason: 'invalid_result' });
        throw tryAgain('invalid_result');
      }
      logUsage('proposed');
      const detailed = await withDishDetails(ctx.db, {
        slots: [slot],
        summary: '',
        dropped: 0,
      });
      const [result] = detailed.slots;
      if (!result) throw tryAgain('invalid_result');
      return { slot: result };
    }),
});

type PlanInput = ProposePlanInput | ProposeSlotInput;

// The cheap checks both calls run before the model: none of these call it or
// count towards a limit. Returns the household's library.
async function checkPlanInput(
  ctx: AppContext,
  input: PlanInput,
): Promise<{
  library: MealPlanRecipe[];
  pickableRecipeIds: Set<number>;
  occasionNames: Map<number, string>;
}> {
  const startDate = parseCivilDate(input.startDate);
  const endDate = parseCivilDate(input.endDate);
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
    healthScoreSince: ctx.mealPlan.healthScoreSince,
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
    const fixed = slot.fixed;
    if (fixed?.kind !== 'recipe' && fixed?.kind !== 'batch') continue;
    if (!pickableRecipeIds.has(fixed.recipeId)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A fixed recipe is not pickable',
        cause: {
          code: 'SLOT_RECIPE_NOT_PICKABLE',
          recipeId: fixed.recipeId,
        },
      });
    }
    // People eating at a Batch's slot eat it there.
    if (fixed.kind === 'batch' && fixed.portions < slotHeadcount(slot)) {
      throw domainError(
        'BAD_REQUEST',
        'MEAL_PLAN_BATCH_TOO_SMALL',
        'A batch cooks fewer portions than its slot’s headcount',
        { date: slot.date, occasionId: slot.occasionId },
      );
    }
  }
  return { library, pickableRecipeIds, occasionNames };
}

function slotContexts(
  inputSlots: PlanInput['slots'],
  requestSlots: MealPlanRequest['slots'],
): ProposalSlotContext[] {
  return inputSlots.map((slot, index) => ({
    date: slot.date,
    occasionId: slot.occasionId,
    occasion: requestSlots[index]?.occasion ?? '',
    headcount: slotHeadcount(slot),
    fixed: slot.fixed,
  }));
}

// Metadata only: never the Brief, the note, reasons, the summary or recipe
// names (DEC-117).
function inputDetails(
  input: PlanInput,
  libraryCount: number,
  brief: string | null,
): ModelUsageDetails {
  return {
    slotCount: input.slots.length,
    fixedCount: input.slots.filter(
      (slot) => slot.fixed !== null && slot.fixed.kind !== 'empty',
    ).length,
    libraryCount,
    briefLength: brief?.length ?? 0,
  };
}

type LogUsage = (outcome: string, details?: ModelUsageDetails) => void;

// Calls the planner under the time limit, logging and mapping its failures.
// Returns the candidate, and a logger for the caller's own outcome.
async function callPlanner(
  ctx: AppContext,
  plan: (signal: AbortSignal) => Promise<MealPlanning>,
  signal: AbortSignal | undefined,
  baseDetails: ModelUsageDetails,
): Promise<{
  outcome: Extract<MealPlannerOutcome, { kind: 'candidate' }>;
  logUsage: LogUsage;
}> {
  const { planner } = ctx.mealPlan;
  const timeout = AbortSignal.timeout(MEAL_PLAN_TIMEOUT_MS);
  const planSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const startedAt = performance.now();
  let usage: MealPlannerUsage | null = null;
  const logUsage: LogUsage = (outcome, details = {}) => {
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
      { ...baseDetails, ...details },
    );
  };

  let planning: MealPlanning;
  try {
    planning = await plan(planSignal);
  } catch (error) {
    if (error instanceof MealPlannerTimeoutError) {
      logUsage('MEAL_PLAN_TRY_AGAIN', { reason: 'timeout' });
      throw tryAgain('timeout');
    }
    if (error instanceof MealPlannerUnavailableError) {
      logUsage('MEAL_PLAN_TRY_AGAIN', {
        reason: 'unavailable',
        providerStatus: error.status,
      });
      throw tryAgain('unavailable');
    }
    // Our request was wrong, so the provider's reason is kept for whoever
    // fixes it. It reaches Sentry with the domain code only.
    if (error instanceof MealPlannerRequestError) {
      logUsage('MEAL_PLAN_REQUEST_REJECTED', {
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

  usage = planning.usage;
  const { outcome } = planning;
  if (outcome.kind === 'refused') {
    logUsage('MEAL_PLAN_NOT_PROPOSED');
    throw domainError(
      'UNPROCESSABLE_CONTENT',
      'MEAL_PLAN_NOT_PROPOSED',
      'A plan couldn’t be proposed',
    );
  }
  return { outcome, logUsage };
}

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
