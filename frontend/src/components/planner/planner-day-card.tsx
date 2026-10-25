import type { HealthScoreAverage } from '@loftys-larder/shared';
import { useId } from 'react';
import type { ReactNode, Ref } from 'react';

import { HealthScoreAverageBadge } from '@/components/planner/health-score-average-badge.tsx';
import { PlantPointsBadge } from '@/components/planner/plant-points-badge.tsx';
import { formatLongDayLabel } from '@/lib/date-utils.ts';
import { cn } from '@/lib/utils.ts';

// One day of the plan below `md` (FEAT-72, DEC-115): the day's header, then a
// row per occasion holding whatever the grid would put in that cell.
export interface PlannerDayCardProps {
  date: string;
  isToday: boolean;
  occasions: readonly { id: number; name: string }[];
  renderSlot: (occasionId: number) => ReactNode;
  // Same contract as the grid: `null` is loading, `undefined` hides the badge.
  plantCount?: number | null;
  healthScore?: HealthScoreAverage | null;
  ref?: Ref<HTMLElement>;
}

export function PlannerDayCard({
  date,
  isToday,
  occasions,
  renderSlot,
  plantCount,
  healthScore,
  ref,
}: PlannerDayCardProps): React.ReactElement {
  const headingId = useId();
  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      data-day={date}
      className={cn(
        'scroll-mt-16 rounded-lg border bg-card px-3 py-2',
        isToday ? 'border-2 border-primary' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between gap-2 pb-1">
        <h2 id={headingId} className="flex items-center gap-2 font-medium">
          {formatLongDayLabel(date)}
          {isToday && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              Today
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1">
          {plantCount !== undefined && (
            <PlantPointsBadge count={plantCount} variant="day" />
          )}
          {healthScore !== undefined && (
            <HealthScoreAverageBadge value={healthScore} variant="day" />
          )}
        </div>
      </div>
      <div className="divide-y divide-border">
        {occasions.map((occasion) => (
          <div
            key={occasion.id}
            className="grid grid-cols-[4rem_minmax(0,1fr)] items-start gap-2 py-2"
          >
            <span className="pt-2 text-xs text-muted-foreground">
              {occasion.name}
            </span>
            {renderSlot(occasion.id)}
          </div>
        ))}
      </div>
    </section>
  );
}
