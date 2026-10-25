import type { HealthScoreAverage } from '@loftys-larder/shared';

import { cn } from '@/lib/utils.ts';

// The day or plan Health Score (DEC-113), beside the plant-points badge:
// eaten dishes' scores averaged by eaten servings, labelled AI. Muted when an
// out-of-date score went into it, as the recipe chip is. The day badge keeps
// its not-scored note to the accessible name and tooltip, since a phone's day
// header has no room for it; the plan header shows it. `value = null` is a
// loading skeleton, and with no scored dish eaten there's no value to show.
export interface HealthScoreAverageBadgeProps {
  value: HealthScoreAverage | null;
  variant?: 'day' | 'plan';
  className?: string;
}

export function HealthScoreAverageBadge({
  value,
  variant = 'day',
  className,
}: HealthScoreAverageBadgeProps): React.ReactElement | null {
  const isPlan = variant === 'plan';
  const chip = cn(
    'inline-flex items-center gap-1 rounded-full border font-medium',
    isPlan ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-0.5 text-[10px]',
  );

  if (value === null) {
    return (
      <span
        data-testid="health-score-average-loading"
        role="status"
        className={cn(chip, 'animate-pulse text-muted-foreground', className)}
      >
        <span aria-hidden="true">AI ·</span>
        <span className="sr-only">Loading AI health score</span>
      </span>
    );
  }

  const { average, notScored, includesOutOfDate } = value;
  const notScoredNote =
    notScored === 0
      ? null
      : `${String(notScored)} ${notScored === 1 ? 'dish' : 'dishes'} not scored`;

  if (average === null) {
    if (!isPlan || notScoredNote === null) return null;
    return (
      <span
        data-testid="health-score-average-not-scored"
        className={cn('text-xs text-muted-foreground', className)}
      >
        {notScoredNote}
      </span>
    );
  }

  const shown = average.toFixed(1);
  const description = [
    `AI health score ${shown} out of 10${isPlan ? ' for this plan' : ''}`,
    includesOutOfDate ? 'out of date' : null,
    notScoredNote,
  ]
    .filter((part) => part !== null)
    .join(', ');

  return (
    <span
      data-testid="health-score-average"
      title={description}
      className={cn('inline-flex items-center gap-1', className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          chip,
          includesOutOfDate
            ? 'border-dashed text-muted-foreground'
            : 'text-foreground',
        )}
      >
        <span>AI</span>
        <span>{shown}</span>
        {isPlan && includesOutOfDate && <span>· out of date</span>}
      </span>
      {isPlan && notScoredNote !== null && (
        <span aria-hidden="true" className="text-xs text-muted-foreground">
          {notScoredNote}
        </span>
      )}
      <span className="sr-only">{description}</span>
    </span>
  );
}
