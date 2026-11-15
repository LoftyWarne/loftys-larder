import type { ShoppingListLine } from '@loftys-larder/shared';

import { Checkbox } from '@/components/ui/checkbox.tsx';
import { formatDayLabel } from '@/lib/date-utils.ts';
import { formatQuantity } from '@/lib/format-quantity.ts';
import { cn } from '@/lib/utils.ts';

import { HoldingsChip } from './holdings-chip.tsx';
import { ShelfLifeBadge } from './shelf-life-badge.tsx';

export interface ListLineProps {
  line: ShoppingListLine;
  onToggle: (line: ShoppingListLine, nextChecked: boolean) => void;
  /**
   * The toggle is sitting in the offline queue waiting for reconnect-drain
   * (FEAT-43). The line renders a small "Pending sync" indicator; print CSS
   * hides it via `data-print-hide`.
   */
  isQueued?: boolean;
  /** Opens the line's storage sheet from its holdings chip. */
  onOpenStorage?: (line: ShoppingListLine) => void;
  /** Reserving needs a connection, so the chip is off while offline. */
  canReserve?: boolean;
}

// One shopping-list row. Tap-target sizing (min 44 px) and single-row layout
// keep it one-handed on a phone. Contributing recipes hide behind a native
// `<details>` so the disclosure is keyboard-friendly and screen-reader-clean;
// print CSS hides the whole `<details>` regardless.
export function ListLine({
  line,
  onToggle,
  isQueued = false,
  onOpenStorage,
  canReserve = true,
}: ListLineProps): React.ReactElement {
  const checkboxId = `shopping-line-${String(line.ingredient.id)}`;
  const unit = line.unit.name;
  const show = (quantity: string): string =>
    `${formatQuantity(quantity, unit)} ${unit}`;
  const partlyReserved = Number(line.reserved) > 0 && !line.fromStorage;
  const totalLabel = line.fromStorage
    ? 'From storage'
    : partlyReserved
      ? `${show(line.leftToBuy)} to buy`
      : show(line.totalQuantity);

  return (
    <li
      data-shopping-line
      data-ingredient-id={line.ingredient.id}
      className={cn(
        'flex flex-col gap-1 border-b border-border py-3 last:border-b-0',
      )}
    >
      <div className="flex min-h-11 items-center gap-3">
        {line.fromStorage ? (
          // Nothing to buy, so nothing to tick.
          <span aria-hidden="true" className="size-4 shrink-0" />
        ) : (
          <Checkbox
            id={checkboxId}
            checked={line.isChecked}
            onCheckedChange={(value) => {
              onToggle(line, value === true);
            }}
            aria-label={`Mark ${line.ingredient.name} as ${line.isChecked ? 'not bought' : 'bought'}`}
          />
        )}
        <label
          htmlFor={line.fromStorage ? undefined : checkboxId}
          className={cn(
            'flex flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-base',
            !line.fromStorage && 'cursor-pointer',
            line.isChecked && 'text-muted-foreground line-through opacity-60',
          )}
        >
          <span>
            <span className="font-medium">{line.ingredient.name}</span>
            {line.isOptional && (
              <span
                data-shopping-optional
                className="ml-2 text-sm text-muted-foreground"
              >
                (optional)
              </span>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <span
              data-shopping-total
              className={cn(
                'tabular-nums',
                line.fromStorage && 'text-muted-foreground',
              )}
            >
              {totalLabel}
            </span>
            {partlyReserved && (
              <span
                data-shopping-reserved
                className="text-sm text-muted-foreground"
              >
                ({show(line.reserved)} from storage)
              </span>
            )}
            {line.shelfLifeWarning && (
              <ShelfLifeBadge warning={line.shelfLifeWarning} />
            )}
            {isQueued && (
              <span
                data-shopping-pending-sync
                data-print-hide
                role="status"
                aria-label="Pending sync"
                className="rounded-sm bg-muted px-1.5 py-0.5 text-xs uppercase tracking-wide text-muted-foreground"
              >
                Pending sync
              </span>
            )}
          </span>
        </label>
      </div>
      {onOpenStorage && line.stockItems.length > 0 && (
        <div className="ml-8">
          <HoldingsChip
            line={line}
            disabled={!canReserve}
            onOpen={onOpenStorage}
          />
        </div>
      )}
      <details
        data-shopping-contributors
        className="ml-8 text-sm text-muted-foreground"
      >
        <summary className="cursor-pointer select-none text-xs uppercase tracking-wide">
          From {String(line.contributingSlots.length)} meal
          {line.contributingSlots.length === 1 ? '' : 's'}
        </summary>
        <ul className="mt-1 space-y-0.5">
          {line.contributingSlots.map((slot) => (
            <li
              key={slot.slotId}
              className="flex flex-wrap items-baseline justify-between gap-x-3"
            >
              <span>
                {slot.recipeName}
                {/* Only worth calling out on a mixed line — a fully optional
                    line is already labelled above. */}
                {!line.isOptional && slot.isOptional && ' (optional)'}
              </span>
              <span className="flex items-baseline gap-2 text-muted-foreground/80">
                <span>{formatDayLabel(slot.date)}</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {formatQuantity(slot.scaledQuantity, line.unit.name)}{' '}
                  {line.unit.name}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
