import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { describe, expect, it, vi } from 'vitest';
import { unauthorizedRedirectLink } from './trpc.ts';

function runLink({
  errorData,
}: {
  errorData: Record<string, unknown> | undefined;
}) {
  const onUnauthorized = vi.fn();
  const link = unauthorizedRedirectLink(onUnauthorized)({});
  const errorHandler = vi.fn();
  const teardown = () => undefined;

  link({
    op: {} as never,
    next: () =>
      observable((observer) => {
        const err = new TRPCClientError('boom', {
          result: { error: { data: errorData } } as never,
        });
        observer.error(err);
        return teardown;
      }),
  }).subscribe({ error: errorHandler });

  return { onUnauthorized, errorHandler };
}

describe('unauthorizedRedirectLink', () => {
  it('calls onUnauthorized when the downstream link errors with UNAUTHORIZED', () => {
    const { onUnauthorized, errorHandler } = runLink({
      errorData: { code: 'UNAUTHORIZED' },
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledTimes(1);
  });

  it('does not call onUnauthorized for other error codes', () => {
    const { onUnauthorized, errorHandler } = runLink({
      errorData: { code: 'BAD_REQUEST' },
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledTimes(1);
  });
});
