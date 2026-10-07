import type { RecipeHealthScore } from '@loftys-larder/shared';

import { cn } from '@/lib/utils.ts';

// A recipe's AI health score as a "7/10" chip (DEC-112). One neutral colour
// for every score: traffic-light colours would read as the FSA scheme. It's
// never called an estimate, because a Health Score isn't one. Nothing shows
// for an unscored recipe.
export function HealthScoreChip({
  healthScore,
  isScoring = false,
  className,
}: {
  healthScore: RecipeHealthScore | null;
  isScoring?: boolean;
  className?: string;
}): React.ReactElement | null {
  const chip =
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium';
  if (isScoring) {
    return (
      <span className={cn(chip, 'text-muted-foreground', className)}>
        Scoring…
      </span>
    );
  }
  if (!healthScore) return null;
  const { score, isStale } = healthScore;
  return (
    <span
      title="AI health score"
      className={cn(
        chip,
        isStale ? 'border-dashed text-muted-foreground' : 'text-foreground',
        className,
      )}
    >
      <span aria-hidden="true">{String(score)}/10</span>
      <span className="sr-only">AI health score {String(score)} out of 10</span>
      {isStale && <span>· out of date</span>}
    </span>
  );
}
