import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button.tsx';
import { addCivilDays, todayInLondon } from '@/lib/date-utils.ts';
import { trpc } from '@/lib/trpc.ts';

// How many days ahead of an upcoming plan's start we treat it as "the plan
// you're about to shop for". The household's shop lands the night before a
// plan begins, so on that eve the shopping view should default to the
// *upcoming* plan rather than the one that happens to still be active today.
// Two days keeps that working even when the order goes in a night early.
const SHOP_HORIZON_DAYS = 2;

export function ShoppingIndexPage(): React.ReactElement {
  const navigate = useNavigate();
  const activeQuery = trpc.plans.list.useQuery({ status: 'active' });
  const futureQuery = trpc.plans.list.useQuery({ status: 'future' });

  const today = todayInLondon();
  const horizon = addCivilDays(today, SHOP_HORIZON_DAYS);

  // Soonest-first, so the first imminent plan is also the nearest one.
  const futures = [...(futureQuery.data?.items ?? [])].sort((a, b) =>
    a.startDate.localeCompare(b.startDate),
  );
  const imminentPlan = futures.find((plan) => plan.startDate <= horizon);
  const activePlan = activeQuery.data?.items[0];

  // Precedence: shop for the plan starting imminently; else the plan running
  // now; else the next upcoming plan even if it's further out (nothing else to
  // provision for).
  const targetPlan = imminentPlan ?? activePlan ?? futures[0];
  const targetPlanId = targetPlan?.id;

  useEffect(() => {
    if (targetPlanId === undefined) return;
    void navigate({
      to: '/plans/$planId/shopping',
      params: { planId: String(targetPlanId) },
      replace: true,
    });
  }, [targetPlanId, navigate]);

  if (activeQuery.isLoading || futureQuery.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading shopping list…
      </p>
    );
  }
  const error = activeQuery.error ?? futureQuery.error;
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  }
  if (targetPlan) {
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
        No current or upcoming plan. Create one to start a shopping list.
      </p>
      <Button asChild>
        <Link to="/plans">Go to plans</Link>
      </Button>
    </section>
  );
}
