import type { StockItem, StorageLocation } from '@loftys-larder/shared';
import { Link } from '@tanstack/react-router';
import { ChevronDown, Minus, Pencil, Plus } from 'lucide-react';
import { useId, useState } from 'react';

import { RecipeTypeBadge } from '@/components/planner/recipe-type-badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import type { StockEdits } from '@/hooks/use-stock-edits.ts';
import {
  formatRowAmount,
  formatStockAge,
  formatStockAmount,
  formatUseBy,
  isPastUseBy,
  stepEdit,
  toMilli,
  type StorageRow,
} from '@/lib/storage-rows.ts';
import { cn } from '@/lib/utils.ts';

interface StockRowProps {
  row: StorageRow;
  location: StorageLocation;
  today: string;
  edits: StockEdits;
  onEdit: (item: StockItem) => void;
}

function RowName({ row }: { row: StorageRow }): React.ReactElement {
  const { target } = row;
  if (target.kind === 'ingredient') {
    return <span className="font-medium">{target.name}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {target.isDeleted ? (
        <span className="font-medium">
          {target.name}
          <span className="ml-1 text-xs text-muted-foreground">(deleted)</span>
        </span>
      ) : (
        <Link
          to="/recipes/$recipeId"
          params={{ recipeId: String(target.recipeId) }}
          className="font-medium text-primary underline-offset-2 hover:underline focus-visible:underline"
        >
          {target.name}
        </Link>
      )}
      {target.isBase && (
        <RecipeTypeBadge recipe={{ isBase: true, baseRecipeId: null }} />
      )}
    </span>
  );
}

// One row on the Storage screen: a Fridge item, or every Freezer or Pantry
// item of one ingredient or dish. The stepper changes the amount in one tap.
export function StockRow({
  row,
  location,
  today,
  edits,
  onEdit,
}: StockRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const itemsId = useId();
  const combined = row.items.length > 1;
  const single = row.items[0];
  const past = location === 'fridge' && isPastUseBy(row.useBy, today);
  const name = row.target.name;

  function step(direction: -1 | 1): void {
    const edit = stepEdit(row, direction);
    if (!edit) return;
    void edits.run({
      kind: 'update',
      input: { id: edit.id, patch: { quantity: edit.quantity } },
    });
  }

  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <RowName row={row} />
          <p className="text-sm tabular-nums">{formatRowAmount(row)}</p>
          <p className="text-xs text-muted-foreground">
            {formatStockAge(row.oldestAddedOn, today, location)}
            {location === 'fridge' && (
              <>
                {' · '}
                <span className={cn(past && 'font-semibold text-destructive')}>
                  {formatUseBy(row.useBy, today)}
                </span>
              </>
            )}
          </p>
        </div>
        <div
          role="group"
          aria-label={`Amount of ${name}`}
          className="flex shrink-0 items-center gap-1"
        >
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={`Less ${name}`}
            disabled={edits.pending}
            onClick={() => {
              step(-1);
            }}
          >
            <Minus aria-hidden className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={`More ${name}`}
            disabled={edits.pending}
            onClick={() => {
              step(1);
            }}
          >
            <Plus aria-hidden className="size-4" />
          </Button>
          {combined ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`${expanded ? 'Hide' : 'Show'} each ${name} item`}
              aria-expanded={expanded}
              aria-controls={itemsId}
              onClick={() => {
                setExpanded((open) => !open);
              }}
            >
              <ChevronDown
                aria-hidden
                className={cn(
                  'size-4 transition-transform',
                  expanded && 'rotate-180',
                )}
              />
            </Button>
          ) : (
            single && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Edit ${name}`}
                onClick={() => {
                  onEdit(single);
                }}
              >
                <Pencil aria-hidden className="size-4" />
              </Button>
            )
          )}
        </div>
      </div>
      {combined && expanded && (
        <ul id={itemsId} className="mt-2 space-y-1 border-l-2 pl-3">
          {row.items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2"
            >
              <span className="text-sm">
                <span className="tabular-nums">
                  {formatStockAmount(toMilli(item.quantity), item.target)}
                </span>
                <span className="text-muted-foreground">
                  {' · '}
                  {formatStockAge(item.addedOn, today, location)}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  onEdit(item);
                }}
              >
                Edit
                <span className="sr-only">
                  {' '}
                  {formatStockAmount(
                    toMilli(item.quantity),
                    item.target,
                  )} of {name}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
