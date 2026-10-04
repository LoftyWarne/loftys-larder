import type { RecipeImportAdapter } from '../../config.ts';

// The Recipe Import seam (DEC-109). An adapter turns a prepared import input
// into an unvalidated candidate; `normaliseProposal` checks every candidate
// the same way, whichever adapter produced it. Adapters stop when the signal
// aborts, map their provider's refusals to not a recipe, and never log.

export interface RecipeReaderHousehold {
  ingredients: { id: number; name: string; unitId: number; unitName: string }[];
  categories: { id: number; name: string }[];
  units: { id: number; name: string }[];
  prepTypes: { id: number; name: string }[];
  tags: { id: number; name: string }[];
  sources: { id: number; name: string }[];
}

// Prepared before the seam. Images and web pages will join text here.
export interface RecipeReaderInput {
  kind: 'text';
  text: string;
}

export interface RecipeReadRequest {
  input: RecipeReaderInput;
  household: RecipeReaderHousehold;
  // The recipe the cook picked when the input held several.
  pick: string | null;
}

export type RecipeReaderOutcome =
  | { kind: 'candidate'; candidate: unknown }
  | { kind: 'several'; names: string[] }
  | { kind: 'not_a_recipe' };

export interface RecipeReaderUsage {
  // The model that answered, which a provider fallback can change.
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface RecipeReading {
  outcome: RecipeReaderOutcome;
  usage: RecipeReaderUsage;
}

export interface RecipeReader {
  adapter: RecipeImportAdapter;
  // The model asked for.
  model: string;
  read(request: RecipeReadRequest, signal: AbortSignal): Promise<RecipeReading>;
}

export class RecipeReaderTimeoutError extends Error {
  constructor() {
    super('The recipe reader timed out');
    this.name = 'RecipeReaderTimeoutError';
  }
}

export class RecipeReaderUnavailableError extends Error {
  constructor(
    // Metadata only: an HTTP status, never provider text.
    readonly status: number | null,
  ) {
    super('The recipe reader is unavailable');
    this.name = 'RecipeReaderUnavailableError';
  }
}
