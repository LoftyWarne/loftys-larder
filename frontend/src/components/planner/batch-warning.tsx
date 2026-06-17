import { cn } from '@/lib/utils.ts';

// Soft warning rendered on a slot's editor + card when a batch-version meal
// has no earlier (or same-slot) base supply in this plan. Non-blocking — the
// user can save through it; it just nudges them to add a base cook somewhere.
export interface BatchWarningProps {
  className?: string;
}

export function BatchWarning({
  className,
}: BatchWarningProps): React.ReactElement {
  return (
    <div
      role="status"
      data-testid="batch-supply-warning"
      className={cn(
        'flex items-center gap-1 text-xs text-amber-700',
        className,
      )}
    >
      <span aria-hidden="true">⚠</span>
      <span>No earlier base cook in this plan</span>
    </div>
  );
}
