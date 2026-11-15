import type { StorageLocation } from '@loftys-larder/shared';
import { Link } from '@tanstack/react-router';

import { cn } from '@/lib/utils.ts';

export const LOCATION_LABELS: Record<StorageLocation, string> = {
  freezer: 'Freezer',
  fridge: 'Fridge',
  pantry: 'Pantry',
};

const ORDER: StorageLocation[] = ['freezer', 'fridge', 'pantry'];

// One tab per Storage location. The location lives in the URL, so a tab is a
// link to it.
export function LocationTabs({
  current,
  counts,
}: {
  current: StorageLocation;
  counts: Record<StorageLocation, number>;
}): React.ReactElement {
  return (
    <nav aria-label="Storage locations" className="grid grid-cols-3 border-b">
      {ORDER.map((location) => {
        const isCurrent = location === current;
        return (
          <Link
            key={location}
            to="/storage"
            search={{ location }}
            aria-current={isCurrent ? 'page' : undefined}
            className={cn(
              'border-b-2 px-2 py-2 text-center text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isCurrent
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {LOCATION_LABELS[location]}
            <span className="ml-1 tabular-nums">({counts[location]})</span>
          </Link>
        );
      })}
    </nav>
  );
}
