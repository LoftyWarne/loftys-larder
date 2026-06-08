import {
  domainErrorCauseSchema,
  type DomainErrorCode,
} from '@loftys-larder/shared';
import { TRPCClientError } from '@trpc/client';

// Read a typed domain error code off a tRPC error. The shape is established
// in FEAT-17: tRPC standard code on `code`, domain code on `cause.code` (DEC-35,
// cross-cutting #11). Returns `null` if the error is non-tRPC or carries no
// typed cause — caller falls back to the standard tRPC code and a generic
// message.
export function getDomainErrorCode(error: unknown): DomainErrorCode | null {
  if (!(error instanceof TRPCClientError)) return null;
  const rawCause = (error.shape as { data?: { cause?: unknown } } | undefined)
    ?.data?.cause;
  if (rawCause === undefined) return null;
  const parsed = domainErrorCauseSchema.safeParse(rawCause);
  return parsed.success ? parsed.data.code : null;
}
