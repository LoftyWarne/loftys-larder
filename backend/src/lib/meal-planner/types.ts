import type {
  MealPlanRequest,
  MealPlanSlotRequest,
} from '../../../../shared/src/index.ts';
import type { MealPlanAdapter } from '../../config.ts';

// The AI meal planning seam (DEC-117, in DEC-109's pattern). An adapter turns
// a plan's slots and the household's library into an unvalidated candidate,
// for the whole plan or one slot; `normalisePlanProposal` and
// `normaliseSlotSuggestion` check every candidate the same way, whichever
// adapter produced it. Adapters stop when the signal aborts, map their
// provider's refusals to `refused`, and never log.

export type MealPlannerOutcome =
  | { kind: 'candidate'; candidate: unknown }
  | { kind: 'refused' };

export interface MealPlannerUsage {
  // The model that answered, which a provider fallback can change.
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface MealPlanning {
  outcome: MealPlannerOutcome;
  usage: MealPlannerUsage;
}

export interface MealPlanner {
  adapter: MealPlanAdapter;
  // The model asked for.
  model: string;
  propose(request: MealPlanRequest, signal: AbortSignal): Promise<MealPlanning>;
  proposeSlot(
    request: MealPlanSlotRequest,
    signal: AbortSignal,
  ): Promise<MealPlanning>;
}

export class MealPlannerTimeoutError extends Error {
  constructor() {
    super('The meal planner timed out');
    this.name = 'MealPlannerTimeoutError';
  }
}

export class MealPlannerUnavailableError extends Error {
  constructor(
    // Metadata only: an HTTP status, never provider text.
    readonly status: number | null,
  ) {
    super('The meal planner is unavailable');
    this.name = 'MealPlannerUnavailableError';
  }
}

// The provider refused the request itself: a bug or a configuration problem
// on our side, not an outage.
export class MealPlannerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly providerErrorType: string | null,
    readonly providerMessage: string | null,
    readonly providerRequestId: string | null,
  ) {
    super('The meal planner refused the request');
    this.name = 'MealPlannerRequestError';
  }
}
