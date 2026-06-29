import { cn } from '@/lib/utils.ts';

// Soft warning shown when a slot eats more base than has been cooked up to that
// point in the plan (the running consumption balance went negative — see
// `deriveBaseBalances`). Non-blocking — the user can save through it; the base
// may have been prepped in an earlier period. `shortBy` is how many base
// servings short the slot is; omit it for the "nothing cooked at all" nudge.
export interface ServingVariationWarningProps {
  className?: string;
  shortBy?: number;
}

export function ServingVariationWarning({
  className,
  shortBy,
}: ServingVariationWarningProps): React.ReactElement {
  return (
    <div
      role="status"
      data-testid="serving-variation-warning"
      className={cn(
        'flex items-center gap-1 text-xs text-amber-700',
        className,
      )}
    >
      <span aria-hidden="true">⚠</span>
      <span>
        {shortBy !== undefined && shortBy > 0
          ? `Not enough base cooked yet — short by ${String(shortBy)}`
          : 'No base cooked in this plan — fine if you prepped it earlier'}
      </span>
    </div>
  );
}
