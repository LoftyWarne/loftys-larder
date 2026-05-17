import { Button } from '@/components/ui/button.tsx';
import { trpc } from '@/lib/trpc.ts';

export function IndexPage(): React.ReactElement {
  const ping = trpc.health.ping.useQuery();

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Lofty&apos;s Larder</h1>
      {ping.isLoading && <p role="status">Pinging server…</p>}
      {ping.error && (
        <p role="alert" className="text-destructive">
          Health check failed: {ping.error.message}
        </p>
      )}
      {ping.data && (
        <p>
          Server reqId:{' '}
          <code data-testid="req-id" className="rounded bg-muted px-2 py-1">
            {ping.data.reqId}
          </code>
        </p>
      )}
      <Button onClick={() => void ping.refetch()}>Re-ping</Button>
    </section>
  );
}
