import type { PlanSlotItem } from '@loftys-larder/shared';
import { Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';

export interface StoreCounts {
  frozen: number;
  chilled: number;
}

export interface StoreDialogProps {
  // The dish being stored from; `null` closes the dialog.
  item: PlanSlotItem | null;
  // The plan's remaining portions of the dish's recipe, before this change.
  remainingInPlan: number;
  isSaving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (counts: StoreCounts) => void;
}

// "Store…" on a slot card (FEAT-79): set how many of a dish's portions go to
// the Freezer and how many are kept in the Fridge, up or down. It opens at the
// dish's current counts. The first raise of a count adds the plan's remaining
// portions of the dish, capped at what's spare, so the common case is one tap;
// later raises add one.
export function StoreDialog({
  item,
  remainingInPlan,
  isSaving,
  error,
  onClose,
  onSubmit,
}: StoreDialogProps): React.ReactElement {
  const [counts, setCounts] = useState<StoreCounts>({ frozen: 0, chilled: 0 });
  const itemId = item?.id ?? null;
  const startFrozen = item?.frozen ?? 0;
  const startChilled = item?.chilled ?? 0;

  useEffect(() => {
    if (itemId === null) return;
    setCounts({ frozen: startFrozen, chilled: startChilled });
  }, [itemId, startFrozen, startChilled]);

  const available = item ? item.prepared - item.eaten : 0;
  const storing = counts.frozen + counts.chilled;
  const leftAfter = item
    ? remainingInPlan -
      (counts.frozen - item.frozen) -
      (counts.chilled - item.chilled)
    : 0;
  const changed =
    item !== null &&
    (counts.frozen !== item.frozen || counts.chilled !== item.chilled);

  function step(key: keyof StoreCounts, delta: -1 | 1): void {
    if (!item) return;
    const start = item[key];
    setCounts((prev) => {
      if (delta < 0) {
        return prev[key] > 0 ? { ...prev, [key]: prev[key] - 1 } : prev;
      }
      const room = available - prev.frozen - prev.chilled;
      if (room <= 0) return prev;
      // A first raise jumps by the plan's leftovers (DEC-88's remaining pool),
      // net of what this dialog has already moved to the other place.
      const movedElsewhere =
        key === 'frozen'
          ? prev.chilled - item.chilled
          : prev.frozen - item.frozen;
      const leftovers = remainingInPlan - movedElsewhere;
      const jump =
        prev[key] === start ? Math.max(1, Math.min(room, leftovers)) : 1;
      return { ...prev, [key]: prev[key] + Math.min(jump, room) };
    });
  }

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Store {item?.recipeName ?? ''}</DialogTitle>
          <DialogDescription>
            {String(available)} {portions(available)} not eaten here.{' '}
            {leftAfter >= 0
              ? `${String(leftAfter)} left in plan after this.`
              : `A later meal is counting on ${String(-leftAfter)} of these.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <CountRow
            label="Freezer"
            value={counts.frozen}
            canRaise={storing < available}
            onStep={(delta) => {
              step('frozen', delta);
            }}
          />
          <CountRow
            label="Fridge"
            value={counts.chilled}
            canRaise={storing < available}
            onStep={(delta) => {
              step('chilled', delta);
            }}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!changed || isSaving}
            onClick={() => {
              onSubmit(counts);
            }}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CountRow({
  label,
  value,
  canRaise,
  onStep,
}: {
  label: string;
  value: number;
  canRaise: boolean;
  onStep: (delta: -1 | 1) => void;
}): React.ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center justify-between gap-2 text-sm"
    >
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`Fewer in the ${label}`}
          disabled={value <= 0}
          onClick={() => {
            onStep(-1);
          }}
        >
          <Minus className="h-4 w-4" aria-hidden="true" />
        </Button>
        <span aria-live="polite" className="w-16 text-center tabular-nums">
          {String(value)} {portions(value)}
        </span>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`More in the ${label}`}
          disabled={!canRaise}
          onClick={() => {
            onStep(1);
          }}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </Button>
      </span>
    </div>
  );
}

function portions(count: number): string {
  return count === 1 ? 'portion' : 'portions';
}
