import { z } from 'zod';

// Domain-specific error codes attached to TRPCError via `cause`. The standard
// tRPC code (e.g. CONFLICT) goes on `code`; the structured cause carries the
// domain code plus any metadata the UI needs (DEC-35, cross-cutting #11).
// First wired in FEAT-17 for ingredient deletion + uniqueness collisions.
export const DOMAIN_ERROR_CODES = [
  'INGREDIENT_IN_USE',
  'INGREDIENT_NAME_TAKEN',
  'RECIPE_INGREDIENT_UNIT_MISMATCH',
  'RECIPE_INGREDIENT_NOT_FOUND',
  'RECIPE_BATCH_XOR_VIOLATION',
  'RECIPE_BATCH_BASE_NOT_FOUND',
  'RECIPE_BATCH_BASE_NOT_PICKABLE',
  'RECIPE_BATCH_PAIR_NOT_FOUND',
  'RECIPE_BATCH_PAIR_SELF',
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
