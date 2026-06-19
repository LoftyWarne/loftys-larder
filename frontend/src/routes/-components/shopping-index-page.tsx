import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button.tsx';
import { trpc } from '@/lib/trpc.ts';

export function ShoppingIndexPage(): React.ReactElement {
  const navigate = useNavigate();
  const listQuery = trpc.plans.list.useQuery({ status: 'active' });

  const activePlan = listQuery.data?.items[0];
  const activePlanId = activePlan?.id;

  useEffect(() => {
    if (activePlanId === undefined) return;
    void navigate({
      to: '/plans/$planId/shopping',
      params: { planId: String(activePlanId) },
      replace: true,
    });
  }, [activePlanId, navigate]);

  if (listQuery.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading shopping list…
      </p>
    );
  }
  if (listQuery.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {listQuery.error.message}
      </p>
    );
  }
  if (activePlan) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Opening shopping list…
      </p>
    );
  }
  return (
    <section className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Shopping list</h1>
      <p className="text-sm text-muted-foreground">
        No active plan right now. Create one to start a shopping list.
      </p>
      <Button asChild>
        <Link to="/plans">Go to plans</Link>
      </Button>
    </section>
  );
}
