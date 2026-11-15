import type { ShoppingListLine, StorageLocation } from '@loftys-larder/shared';

import { formatQuantity } from '@/lib/format-quantity.ts';
import { fromMilli, toMilli } from '@/lib/stock-draws.ts';

const ORDER: StorageLocation[] = ['fridge', 'freezer', 'pantry'];

export const IN_LOCATION: Record<StorageLocation, string> = {
  freezer: 'In freezer',
  fridge: 'In fridge',
  pantry: 'In pantry',
};

// What a line could use from storage, per location ("In freezer: 500 g").
export function holdingsSummary(line: ShoppingListLine): string {
  const byLocation = new Map<StorageLocation, number>();
  for (const item of line.stockItems) {
    byLocation.set(
      item.location,
      (byLocation.get(item.location) ?? 0) + toMilli(item.available),
    );
  }
  return ORDER.filter((location) => (byLocation.get(location) ?? 0) > 0)
    .map(
      (location) =>
        `${IN_LOCATION[location]}: ${formatQuantity(fromMilli(byLocation.get(location) ?? 0), line.unit.name)} ${line.unit.name}`,
    )
    .join(' · ');
}

// Opens the line's storage sheet. Reserving needs a connection, so it's off
// while offline.
export function HoldingsChip({
  line,
  disabled,
  onOpen,
}: {
  line: ShoppingListLine;
  disabled: boolean;
  onOpen: (line: ShoppingListLine) => void;
}): React.ReactElement | null {
  if (line.stockItems.length === 0) return null;
  const summary = holdingsSummary(line);
  return (
    <button
      type="button"
      data-shopping-holdings-chip
      data-print-hide
      disabled={disabled}
      onClick={() => {
        onOpen(line);
      }}
      aria-label={`${line.ingredient.name}: ${summary || 'set aside from storage'}. Choose whether to use it.`}
      className="inline-flex min-h-8 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      {summary || 'Set aside from storage'}
    </button>
  );
}
