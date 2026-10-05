import { z } from 'zod';

// Domain-specific error codes attached to TRPCError via `cause`. The standard
// tRPC code (e.g. CONFLICT) goes on `code`; the structured cause carries the
// domain code plus any metadata the UI needs (DEC-35, cross-cutting #11).
// First wired in FEAT-17 for ingredient deletion + uniqueness collisions.
export const DOMAIN_ERROR_CODES = [
  'INGREDIENT_IN_USE',
  'INGREDIENT_NAME_TAKEN',
  'SOURCE_NAME_TAKEN',
  'RECIPE_INGREDIENT_UNIT_MISMATCH',
  'RECIPE_INGREDIENT_NOT_FOUND',
  'RECIPE_STEP_AMOUNT_EXCEEDS_TOTAL',
  'RECIPE_BASE_XOR_VIOLATION',
  'RECIPE_BASE_NOT_FOUND',
  'RECIPE_BASE_NOT_PICKABLE',
  'RELATED_RECIPE_SELF_LINK',
  'RELATED_RECIPE_DUPLICATE',
  'RELATED_RECIPE_NOT_PICKABLE',
  'PLAN_DATE_OVERLAP',
  'PLAN_RANGE_TOO_LONG',
  'PLAN_DESTRUCTIVE_RANGE_CHANGE',
  'PLAN_PAST_NOT_EDITABLE',
  'SLOT_NOT_FOUND',
  'SLOT_RECIPE_NOT_PICKABLE',
  'SLOT_RECIPE_CROSS_HOUSEHOLD',
  'SLOT_CHEF_NOT_FOUND',
  'SLOT_BASE_CROSS_HOUSEHOLD',
  'SLOT_BASE_NOT_PICKABLE',
  'SLOT_BASE_NOT_BASE',
  'SLOT_ITEM_EAT_ON_NON_RECIPE',
  'SLOT_ITEM_COOK_AHEAD_NOT_BASE',
  'ACCOUNT_DELETE_EMAIL_MISMATCH',
  'ACCOUNT_DELETE_REAUTH_REQUIRED',
  'SHOPPING_INGREDIENT_NOT_IN_PLAN',
  'IMPORT_NOT_A_RECIPE',
  // Metadata `reason`: `timeout`, `unavailable` or `invalid_proposal`.
  'IMPORT_TRY_AGAIN',
  // The provider refused the request itself, so trying again won't help.
  'IMPORT_REQUEST_REJECTED',
  'IMPORT_RATE_LIMITED',
  // A link that isn't https, or that leads to a private address.
  'IMPORT_LINK_NOT_ALLOWED',
  // The page refused the fetch, timed out, was too large or wasn't HTML.
  'IMPORT_LINK_UNREADABLE',
  // Metadata `pageCount` and `maxPages`: a PDF with more pages than an
  // import reads.
  'IMPORT_DOCUMENT_TOO_LONG',
] as const;

export const domainErrorCodeSchema = z.enum(DOMAIN_ERROR_CODES);

export type DomainErrorCode = z.infer<typeof domainErrorCodeSchema>;

// Cause shape: `code` is required + typed; arbitrary metadata is allowed via
// passthrough so callers can carry extra context (e.g. a conflicting recipe
// id) without changing the schema.
export const domainErrorCauseSchema = z
  .object({ code: domainErrorCodeSchema })
  .loose();

export type DomainErrorCause = z.infer<typeof domainErrorCauseSchema>;
