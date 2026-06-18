import type { PlanListItem } from '@loftys-larder/shared';
import { Link } from '@tanstack/react-router';

import { Button } from '@/components/ui/button.tsx';

export interface PlanListCardProps {
  plan: PlanListItem;
  onDuplicate: (plan: PlanListItem) => void;
  onDelete: (plan: PlanListItem) => void;
}

export function PlanListCard({
  plan,
  onDuplicate,
  onDelete,
}: PlanListCardProps): React.ReactElement {
  const summary = `${String(plan.slotsAssigned)}/${String(plan.slotsTotal)} slots assigned`;

  return (
    <article
      className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-4"
      data-testid={`plan-row-${String(plan.id)}`}
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">
          {plan.startDate} – {plan.endDate}
        </h2>
        <p className="text-sm text-muted-foreground">{summary}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to="/plans/$planId" params={{ planId: String(plan.id) }}>
            Open
          </Link>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onDuplicate(plan);
          }}
        >
          Duplicate
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            onDelete(plan);
          }}
        >
          Delete
        </Button>
      </div>
    </article>
  );
}
