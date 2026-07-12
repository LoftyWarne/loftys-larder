import { Link } from '@tanstack/react-router';

import { formatShortDayRangeLabel } from '@/lib/date-utils.ts';
import { trpc } from '@/lib/trpc.ts';
import { cn } from '@/lib/utils.ts';

export interface ShoppingPlanPickerProps {
  currentPlanId: number;
}

// Segmented tabs to switch the shopping list between the current and upcoming
// plans. Hidden unless at least two such plans exist, so the common
// single-plan case shows nothing. Past plans are excluded — reached via
// /plans. The default landing is decided by ShoppingIndexPage's auto-selection
// (DEC-92); this only makes switching between the live lists visible.
export function ShoppingPlanPicker({
  currentPlanId,
}: ShoppingPlanPickerProps): React.ReactElement | null {
  const activeQuery = trpc.plans.list.useQuery({ status: 'active' });
  const futureQuery = trpc.plans.list.useQuery({ status: 'future' });

  const plans = [
    ...(activeQuery.data?.items ?? []),
    ...(futureQuery.data?.items ?? []),
  ].sort((a, b) => a.startDate.localeCompare(b.startDate));

  if (plans.length < 2) return null;

  return (
    <nav
      aria-label="Choose shopping list"
      data-print-hide
      className="inline-flex flex-wrap gap-1 rounded-md border p-1"
    >
      {plans.map((plan) => {
        const isCurrent = plan.id === currentPlanId;
        return (
          <Link
            key={plan.id}
            to="/plans/$planId/shopping"
            params={{ planId: String(plan.id) }}
            aria-current={isCurrent ? 'page' : undefined}
            className={cn(
              'rounded px-3 py-1.5 text-sm font-medium transition-colors',
              isCurrent
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {formatShortDayRangeLabel(plan.startDate, plan.endDate)}
          </Link>
        );
      })}
    </nav>
  );
}
