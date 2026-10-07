import type { HealthScoreRequest } from '../../../../shared/src/index.ts';
import type { HealthScoreAdapter } from '../../config.ts';

// The health scoring seam (DEC-112, in DEC-109's pattern). An adapter turns a
// recipe's scored content into an unvalidated candidate; `normaliseHealthScore`
// checks every candidate the same way, whichever adapter produced it.
// Adapters stop when the signal aborts, map their provider's refusals to
// `refused`, and never log.

export type RecipeScorerOutcome =
  | { kind: 'candidate'; candidate: unknown }
  | { kind: 'refused' };

export interface RecipeScorerUsage {
  // The model that answered, which a provider fallback can change.
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface RecipeScoring {
  outcome: RecipeScorerOutcome;
  usage: RecipeScorerUsage;
}

export interface RecipeScorer {
  adapter: HealthScoreAdapter;
  // The model asked for.
  model: string;
  score(
    request: HealthScoreRequest,
    signal: AbortSignal,
  ): Promise<RecipeScoring>;
}

export class RecipeScorerTimeoutError extends Error {
  constructor() {
    super('The recipe scorer timed out');
    this.name = 'RecipeScorerTimeoutError';
  }
}

export class RecipeScorerUnavailableError extends Error {
  constructor(
    // Metadata only: an HTTP status, never provider text.
    readonly status: number | null,
  ) {
    super('The recipe scorer is unavailable');
    this.name = 'RecipeScorerUnavailableError';
  }
}

// The provider refused the request itself: a bug or a configuration problem
// on our side, not an outage.
export class RecipeScorerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly providerErrorType: string | null,
    readonly providerMessage: string | null,
    readonly providerRequestId: string | null,
  ) {
    super('The recipe scorer refused the request');
    this.name = 'RecipeScorerRequestError';
  }
}
