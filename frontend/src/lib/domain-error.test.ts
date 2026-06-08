import { TRPCClientError } from '@trpc/client';
import { describe, expect, it } from 'vitest';

import { getDomainErrorCode } from './domain-error.ts';

function makeTrpcError(shape: unknown): TRPCClientError<never> {
  const err = new TRPCClientError<never>('boom');
  Object.assign(err, { shape });
  return err;
}

describe('getDomainErrorCode', () => {
  it('returns the domain code for a tRPC error carrying a typed cause', () => {
    const err = makeTrpcError({
      data: { cause: { code: 'INGREDIENT_IN_USE' } },
    });
    expect(getDomainErrorCode(err)).toBe('INGREDIENT_IN_USE');
  });

  it('returns null for a tRPC error with no cause', () => {
    const err = makeTrpcError({ data: {} });
    expect(getDomainErrorCode(err)).toBeNull();
  });

  it('returns null for a tRPC error with an unknown cause code', () => {
    const err = makeTrpcError({
      data: { cause: { code: 'NOT_A_REAL_DOMAIN_CODE' } },
    });
    expect(getDomainErrorCode(err)).toBeNull();
  });

  it('returns null for a non-tRPC error', () => {
    expect(getDomainErrorCode(new Error('boom'))).toBeNull();
  });

  it('returns null when passed undefined', () => {
    expect(getDomainErrorCode(undefined)).toBeNull();
  });
});
