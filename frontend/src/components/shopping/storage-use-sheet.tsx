import type {
  LineReservationChoice,
  ShoppingListLine,
  ShoppingLineStockItem,
} from '@loftys-larder/shared';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { formatDayLabel } from '@/lib/date-utils.ts';
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import { formatQuantity } from '@/lib/format-quantity.ts';
import {
  defaultDraws,
  fromMilli,
  toMilli,
  totalAvailableMilli,
} from '@/lib/stock-draws.ts';
import { trpc } from '@/lib/trpc.ts';

import { IN_LOCATION } from './holdings-chip.tsx';

const AMOUNT_RE = /^\d+(\.\d{1,3})?$/;

function itemDetail(item: ShoppingLineStockItem): string {
  return item.useBy
    ? `use by ${formatDayLabel(item.useBy)}`
    : `added ${formatDayLabel(item.addedOn)}`;
}

// The line's choices (DEC-118): use what's held, buy anyway, or use some and
// buy the rest. "Choose items" changes which Stock items it draws from.
export function StorageUseSheet({
  planId,
  line,
  online,
  onClose,
}: {
  planId: number;
  line: ShoppingListLine | null;
  online: boolean;
  onClose: () => void;
}): React.ReactElement {
  return (
    <Dialog
      open={line !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {line && (
          <SheetBody
            key={line.ingredient.id}
            planId={planId}
            line={line}
            online={online}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SheetBody({
  planId,
  line,
  online,
  onDone,
}: {
  planId: number;
  line: ShoppingListLine;
  online: boolean;
  onDone: () => void;
}): React.ReactElement {
  const fieldId = useId();
  const utils = trpc.useUtils();
  const mutation = trpc.shopping.setLineReservations.useMutation();
  const [error, setError] = useState<string | null>(null);
  const unit = line.unit.name;
  const show = (quantity: string): string =>
    `${formatQuantity(quantity, unit)} ${unit}`;

  const neededMilli = toMilli(line.totalQuantity);
  const availableMilli = totalAvailableMilli(line.stockItems);
  const reservedMilli = toMilli(line.reserved);
  const [amount, setAmount] = useState(
    reservedMilli > 0 && reservedMilli < neededMilli
      ? formatQuantity(line.reserved, unit)
      : '',
  );
  const initialDraws =
    reservedMilli > 0
      ? new Map(
          line.stockItems.map((item) => [
            item.stockItemId,
            toMilli(item.reservedByLine),
          ]),
        )
      : defaultDraws(line.stockItems, Math.min(neededMilli, availableMilli));
  const [draws, setDraws] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      line.stockItems.map((item) => [
        item.stockItemId,
        formatQuantity(
          fromMilli(initialDraws.get(item.stockItemId) ?? 0),
          unit,
        ),
      ]),
    ),
  );

  async function choose(choice: LineReservationChoice): Promise<void> {
    setError(null);
    try {
      await mutation.mutateAsync({
        planId,
        ingredientId: line.ingredient.id,
        choice,
      });
    } catch (caught) {
      const code = getDomainErrorCode(caught);
      setError(
        code === 'SHOPPING_RESERVE_TOO_MUCH'
          ? 'That’s more than is held or needed.'
          : code === 'SHOPPING_INGREDIENT_NOT_IN_PLAN'
            ? 'This plan no longer needs it.'
            : 'Couldn’t save that. Try again.',
      );
      await utils.shopping.getForPlan.invalidate({ planId });
      return;
    }
    await Promise.all([
      utils.shopping.getForPlan.invalidate({ planId }),
      utils.storage.list.invalidate(),
    ]);
    onDone();
  }

  function reserveSome(): void {
    const trimmed = amount.trim();
    if (!AMOUNT_RE.test(trimmed) || Number(trimmed) <= 0) {
      setError('Enter an amount more than 0.');
      return;
    }
    void choose({ kind: 'amount', amount: trimmed });
  }

  function reserveChosenItems(): void {
    const entries: { stockItemId: number; amount: string }[] = [];
    for (const item of line.stockItems) {
      const value = (draws[item.stockItemId] ?? '').trim();
      if (value === '' || Number(value) === 0) continue;
      if (!AMOUNT_RE.test(value)) {
        setError('Amounts must be numbers.');
        return;
      }
      entries.push({ stockItemId: item.stockItemId, amount: value });
    }
    void choose(
      entries.length === 0
        ? { kind: 'none' }
        : { kind: 'draws', draws: entries },
    );
  }

  const busy = mutation.isPending || !online;
  const useAllLabel =
    availableMilli >= neededMilli
      ? `Use ${show(line.totalQuantity)} from storage`
      : `Use all ${show(fromMilli(availableMilli))} from storage`;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{line.ingredient.name}</DialogTitle>
        <DialogDescription>
          This plan needs {show(line.totalQuantity)}. You have{' '}
          {show(fromMilli(availableMilli))} you could use.
          {reservedMilli > 0 && ` ${show(line.reserved)} is set aside now.`}
        </DialogDescription>
      </DialogHeader>

      {!online && (
        <p role="status" className="text-sm text-muted-foreground">
          You’re offline. Using food from storage needs a connection.
        </p>
      )}

      <div className="grid gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            void choose({ kind: 'all' });
          }}
        >
          {useAllLabel}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void choose({ kind: 'none' });
          }}
        >
          Buy anyway
        </Button>
      </div>

      <form
        noValidate
        className="space-y-1"
        onSubmit={(event) => {
          event.preventDefault();
          reserveSome();
        }}
      >
        <label htmlFor={`${fieldId}-some`} className="text-sm font-medium">
          Use some, buy the rest
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={`${fieldId}-some`}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            disabled={busy}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
          <span className="text-sm text-muted-foreground">{unit}</span>
          <Button type="submit" variant="outline" disabled={busy}>
            Use
          </Button>
        </div>
      </form>

      <details className="text-sm">
        <summary className="cursor-pointer select-none font-medium">
          Choose which items
        </summary>
        <form
          noValidate
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            reserveChosenItems();
          }}
        >
          <ul className="space-y-2">
            {line.stockItems.map((item) => (
              <li
                key={item.stockItemId}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <label
                  htmlFor={`${fieldId}-item-${String(item.stockItemId)}`}
                  className="min-w-0"
                >
                  <span className="font-medium">
                    {IN_LOCATION[item.location]}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {show(item.available)} available · {itemDetail(item)}
                  </span>
                </label>
                <span className="flex items-center gap-2">
                  <Input
                    id={`${fieldId}-item-${String(item.stockItemId)}`}
                    className="w-24"
                    inputMode="decimal"
                    autoComplete="off"
                    disabled={busy}
                    value={draws[item.stockItemId] ?? ''}
                    onChange={(event) => {
                      setDraws((current) => ({
                        ...current,
                        [item.stockItemId]: event.target.value,
                      }));
                    }}
                  />
                  <span className="text-muted-foreground">{unit}</span>
                </span>
              </li>
            ))}
          </ul>
          <Button type="submit" variant="outline" disabled={busy}>
            Use these
          </Button>
        </form>
      </details>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
