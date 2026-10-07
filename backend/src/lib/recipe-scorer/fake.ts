import type {
  HealthScoreCandidate,
  HealthScoreRequest,
} from '../../../../shared/src/index.ts';
import {
  RecipeScorerRequestError,
  RecipeScorerTimeoutError,
  RecipeScorerUnavailableError,
  type RecipeScorer,
  type RecipeScoring,
} from './types.ts';

// Canned outcomes for backend tests and e2e, chosen by a marker in the
// recipe's name. Any other recipe scores 7 with a summary and a Suggestion.
export const FAKE_SCORER_MARKERS = {
  refused: '[fake:refused]',
  timeout: '[fake:timeout]',
  unavailable: '[fake:unavailable]',
  invalid: '[fake:invalid]',
  rejected: '[fake:rejected]',
  noSuggestion: '[fake:no-suggestion]',
} as const;

export const FAKE_SCORER_MODEL = 'fake';

export const FAKE_SCORER_CANDIDATE: HealthScoreCandidate = {
  score: 7,
  summary: 'Plenty of vegetables and fibre, but quite a lot of salt.',
  suggestion: 'Halve the salt and add lemon juice at the end.',
};

const usage = { model: FAKE_SCORER_MODEL, inputTokens: 0, outputTokens: 0 };

export function createFakeRecipeScorer(): RecipeScorer {
  return {
    adapter: 'fake',
    model: FAKE_SCORER_MODEL,
    score(request, signal) {
      return Promise.resolve().then(() => scoreFake(request, signal));
    },
  };
}

function scoreFake(
  request: HealthScoreRequest,
  signal: AbortSignal,
): RecipeScoring {
  if (signal.aborted) throw new RecipeScorerTimeoutError();
  const name = request.recipe.name;
  const has = (marker: keyof typeof FAKE_SCORER_MARKERS) =>
    name.includes(FAKE_SCORER_MARKERS[marker]);
  if (has('timeout')) throw new RecipeScorerTimeoutError();
  if (has('unavailable')) throw new RecipeScorerUnavailableError(529);
  if (has('rejected')) {
    throw new RecipeScorerRequestError(
      400,
      'invalid_request_error',
      'Fake rejection',
      'req_fake',
    );
  }
  if (has('refused')) return { outcome: { kind: 'refused' }, usage };
  if (has('invalid')) {
    return {
      outcome: {
        kind: 'candidate',
        candidate: { ...FAKE_SCORER_CANDIDATE, score: 11 },
      },
      usage,
    };
  }
  const candidate: HealthScoreCandidate = has('noSuggestion')
    ? { ...FAKE_SCORER_CANDIDATE, suggestion: null }
    : FAKE_SCORER_CANDIDATE;
  return { outcome: { kind: 'candidate', candidate }, usage };
}
