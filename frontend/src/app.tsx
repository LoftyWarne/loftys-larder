import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { queryClient } from './lib/query-client.ts';
import { createTRPCClient, trpc } from './lib/trpc.ts';
import { router } from './router.tsx';

export function App(): React.ReactElement {
  const [trpcClient] = useState(() =>
    createTRPCClient({
      onUnauthorized: () => {
        void router.navigate({ to: '/sign-in' });
      },
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}
