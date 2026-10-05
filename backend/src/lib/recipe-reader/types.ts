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

// A web page's recipe data, or its text when it has none, capped.
export interface RecipeReaderPageContent {
  format: 'json_ld' | 'text';
  content: string;
  truncated: boolean;
}

// Prepared before the seam.
export type RecipeReaderInput =
  | { kind: 'text'; text: string }
  // Delivery URLs in page order, built by the import procedure. Adapters
  // never build or sign image URLs (DEC-109).
  | { kind: 'images'; urls: string[] }
  // A linked page, fetched by the import procedure behind the SSRF guard, or
  // a page the cook saved as a file. Adapters never fetch pages (DEC-109).
  // `url` is where a linked page was read from, or the address a saved page
  // names as its own; null when a saved page names none.
  | ({ kind: 'page'; url: string | null } & RecipeReaderPageContent);

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

// The provider refused the request itself, for a reason trying again can't
// fix: a request it can't accept, a bad key or an unknown model. That's a
// bug or a configuration problem on our side, not an outage.
export class RecipeReaderRequestError extends Error {
  constructor(
    readonly status: number,
    // The provider's error type and validation message, and its id for the
    // request. The message says what was wrong with the request, so it's
    // logged; it isn't prompt or model text (DEC-104).
    readonly providerErrorType: string | null,
    readonly providerMessage: string | null,
    readonly providerRequestId: string | null,
  ) {
    super('The recipe reader refused the request');
    this.name = 'RecipeReaderRequestError';
  }
}
