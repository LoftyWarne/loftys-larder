import { cn } from '@/lib/utils.ts';

// Small chip showing distinct plant-ingredient count per DEC-32. Used on
// each day rowheader and in the planner page header for the plan total.
// `count = null` renders a skeleton dot so layout doesn't shift while the
// query resolves.
export interface PlantPointsBadgeProps {
  count: number | null;
  variant?: 'day' | 'plan';
  className?: string;
}

export function PlantPointsBadge({
  count,
  variant = 'day',
  className,
}: PlantPointsBadgeProps): React.ReactElement {
  const isPlan = variant === 'plan';
  const baseClass = cn(
    'inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-800',
    isPlan ? 'px-2 py-0.5 text-xs font-medium' : 'px-1.5 py-0.5 text-[10px]',
    className,
  );

  if (count === null) {
    return (
      <span
        data-testid="plant-points-badge-loading"
        role="status"
        aria-label="Loading plant points"
        className={cn(baseClass, 'animate-pulse text-emerald-300')}
      >
        <span aria-hidden="true">🌱</span>
        <span aria-hidden="true">·</span>
      </span>
    );
  }

  const label = isPlan
    ? `${String(count)} plant points in this plan`
    : `${String(count)} plant points`;

  return (
    <span
      data-testid="plant-points-badge"
      aria-label={label}
      className={baseClass}
    >
      <span aria-hidden="true">🌱</span>
      <span>{count}</span>
    </span>
  );
}
