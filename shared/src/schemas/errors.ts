import { z } from 'zod';

// Domain-specific error codes attached to TRPCError via `cause`. The standard
// tRPC code (e.g. CONFLICT) goes on `code`; the structured cause carries the
// domain code plus any metadata the UI needs (DEC-35, cross-cutting #11).
// First wired in FEAT-17 for ingredient deletion + uniqueness collisions.
export const DOMAIN_ERROR_CODES = [
  'INGREDIENT_IN_USE',
  'INGREDIENT_NAME_TAKEN',
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
