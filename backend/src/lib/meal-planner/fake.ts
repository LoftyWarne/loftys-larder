import type {
  MealPlanCandidate,
  MealPlanRequest,
} from '../../../../shared/src/index.ts';
import {
  MealPlannerRequestError,
  MealPlannerTimeoutError,
  MealPlannerUnavailableError,
  type MealPlanner,
  type MealPlanning,
} from './types.ts';

// Canned outcomes for backend tests and e2e, chosen by a marker in the Brief.
// Otherwise the library's recipes are proposed in turn, one per slot that
// isn't fixed and has someone eating. With `batch`, the first such slot cooks
// double its headcount and the next eats the rest as leftovers.
export const FAKE_PLANNER_MARKERS = {
  refused: '[fake:refused]',
  timeout: '[fake:timeout]',
  unavailable: '[fake:unavailable]',
  invalid: '[fake:invalid]',
  rejected: '[fake:rejected]',
  batch: '[fake:batch]',
} as const;

export const FAKE_PLANNER_MODEL = 'fake';

export const FAKE_PLANNER_REASON = 'Not planned for a while.';
export const FAKE_PLANNER_SUMMARY = 'A varied week from your library.';

const usage = { model: FAKE_PLANNER_MODEL, inputTokens: 0, outputTokens: 0 };

export function createFakeMealPlanner(): MealPlanner {
  return {
    adapter: 'fake',
    model: FAKE_PLANNER_MODEL,
    propose(request, signal) {
      return Promise.resolve().then(() => proposeFake(request, signal));
    },
  };
}

function proposeFake(
  request: MealPlanRequest,
  signal: AbortSignal,
): MealPlanning {
  if (signal.aborted) throw new MealPlannerTimeoutError();
  const brief = request.brief ?? '';
  const has = (marker: keyof typeof FAKE_PLANNER_MARKERS) =>
    brief.includes(FAKE_PLANNER_MARKERS[marker]);
  if (has('timeout')) throw new MealPlannerTimeoutError();
  if (has('unavailable')) throw new MealPlannerUnavailableError(529);
  if (has('rejected')) {
    throw new MealPlannerRequestError(
      400,
      'invalid_request_error',
      'Fake rejection',
      'req_fake',
    );
  }
  if (has('refused')) return { outcome: { kind: 'refused' }, usage };
  if (has('invalid')) {
    return {
      outcome: { kind: 'candidate', candidate: { slots: 'none' } },
      usage,
    };
  }
  const open = request.slots.filter(
    (slot) => slot.fixed === null && slot.headcount > 0,
  );
  const batch = has('batch');
  const candidate: MealPlanCandidate = {
    slots: open.flatMap((slot, index): MealPlanCandidate['slots'] => {
      const first = request.recipes[0];
      if (batch && index === 1 && first) {
        return [
          {
            date: slot.date,
            occasion: slot.occasion,
            kind: 'leftovers',
            recipeId: first.id,
            prepared: 0,
            reason: FAKE_PLANNER_REASON,
          },
        ];
      }
      const recipe = request.recipes[index % request.recipes.length];
      return recipe
        ? [
            {
              date: slot.date,
              occasion: slot.occasion,
              kind: 'cook',
              recipeId: recipe.id,
              prepared:
                batch && index === 0 ? slot.headcount * 2 : slot.headcount,
              reason: FAKE_PLANNER_REASON,
            },
          ]
        : [];
    }),
    summary: FAKE_PLANNER_SUMMARY,
  };
  return { outcome: { kind: 'candidate', candidate }, usage };
}
