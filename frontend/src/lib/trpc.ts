import type { AppRouter } from '@loftys-larder/shared';
import { TRPCClientError, httpBatchLink } from '@trpc/client';
import type { TRPCLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';

export const trpc = createTRPCReact<AppRouter>();

export interface CreateTRPCClientOptions {
  onUnauthorized: () => void;
}

export const unauthorizedRedirectLink = (
  onUnauthorized: () => void,
): TRPCLink<AppRouter> => {
  return () => {
    return ({ next, op }) => {
      return observable((observer) => {
        return next(op).subscribe({
          next(value) {
            observer.next(value);
          },
          error(err) {
            if (
              err instanceof TRPCClientError &&
              err.data?.code === 'UNAUTHORIZED'
            ) {
              onUnauthorized();
            }
            observer.error(err);
          },
          complete() {
            observer.complete();
          },
        });
      });
    };
  };
};

export function createTRPCClient({ onUnauthorized }: CreateTRPCClientOptions) {
  return trpc.createClient({
    links: [
      unauthorizedRedirectLink(onUnauthorized),
      httpBatchLink({
        url: '/api/trpc',
        fetch: (input, init) =>
          fetch(input, { ...init, credentials: 'include' }),
      }),
    ],
  });
}
