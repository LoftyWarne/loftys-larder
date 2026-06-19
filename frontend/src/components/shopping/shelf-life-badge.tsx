import type { ShelfLifeWarning } from '@loftys-larder/shared';

import { formatDayLabel } from '@/lib/date-utils.ts';
import { cn } from '@/lib/utils.ts';

export interface ShelfLifeBadgeProps {
  warning: ShelfLifeWarning;
  className?: string;
}

// Non-blocking shelf-life badge (DEC-37). Shows the latest-needed date so the
// cook can plan a second shop if needed. Renders inline next to the line's
// quantity; print stylesheet keeps it visible.
export function ShelfLifeBadge({
  warning,
  className,
}: ShelfLifeBadgeProps): React.ReactElement {
  return (
    <span
      role="note"
      data-shopping-shelf-life-badge
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive',
        className,
      )}
    >
      <span aria-hidden="true">⚠</span>
      <span>Needed by {formatDayLabel(warning.latestNeededDate)}</span>
    </span>
  );
}
