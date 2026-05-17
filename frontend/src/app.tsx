import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { httpBatchLink } from '@trpc/client';
import { useState } from 'react';
import { queryClient } from './lib/query-client.ts';
import { trpc } from './lib/trpc.ts';
import { router } from './router.tsx';

export function App(): React.ReactElement {
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [httpBatchLink({ url: '/api/trpc' })],
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
