import { Link } from '@tanstack/react-router';

import { Button } from '@/components/ui/button.tsx';

// A prompt to check what's held before shopping (DEC-118), shown on each
// plan's list until dismissed for that plan.
export function StorageGlanceBanner({
  onDismiss,
  dismissing,
}: {
  onDismiss: () => void;
  dismissing: boolean;
}): React.ReactElement {
  return (
    <aside
      data-shopping-storage-glance
      data-print-hide
      aria-label="Check your Staples and storage"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm"
    >
      <p>
        <Link
          to="/storage"
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Check your Staples and storage
        </Link>{' '}
        before you shop.
      </p>
      <Button
        variant="ghost"
        size="sm"
        disabled={dismissing}
        onClick={onDismiss}
      >
        Dismiss
      </Button>
    </aside>
  );
}
