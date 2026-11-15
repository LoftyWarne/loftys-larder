import { cn } from '@/lib/utils.ts';

// Soft warning shown when a slot uses more of a recipe than has been cooked up
// to that point in the plan (the running consumption balance went negative — see
// `deriveBaseBalances`, DEC-91). Non-blocking — the user can save through it; the
// dish may have been prepped in an earlier period. `shortBy` is how many
// portions short the slot is; omit it for the "nothing cooked at all" nudge.
//
// `variant` frames the wording: `base` for a Cooking slot drawing its base pool,
// `meal` for a leftover of a non-base meal — there the shortfall is "the meal
// didn't make this many servings", not a base-pool deficit. `storage` for food
// taken from storage (FEAT-81): not enough is held.
export interface ServingVariationWarningProps {
  className?: string;
  shortBy?: number;
  variant?: 'base' | 'meal' | 'storage';
}

export function ServingVariationWarning({
  className,
  shortBy,
  variant = 'base',
}: ServingVariationWarningProps): React.ReactElement {
  const short = shortBy !== undefined && shortBy > 0;
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
      <span>{warningMessage(variant, short ? shortBy : undefined)}</span>
    </div>
  );
}

function warningMessage(
  variant: 'base' | 'meal' | 'storage',
  shortBy: number | undefined,
): string {
  if (shortBy === undefined) {
    return 'No base cooked in this plan — fine if you prepped it earlier';
  }
  if (variant === 'storage') {
    return `Not enough held in storage — short by ${String(shortBy)}`;
  }
  return variant === 'meal'
    ? `Not enough of this meal prepared — short by ${String(shortBy)}`
    : `Not enough base cooked yet — short by ${String(shortBy)}`;
}
