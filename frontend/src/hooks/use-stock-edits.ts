import type { UpdateStockItemInput } from '@loftys-larder/shared';
import { useState } from 'react';

import { getDomainErrorCause } from '@/lib/domain-error.ts';
import { trpc } from '@/lib/trpc.ts';

export type StockEdit =
  | { kind: 'update'; input: UpdateStockItemInput }
  | { kind: 'delete'; id: number };

export interface ReservedConfirm {
  edit: StockEdit;
  onDone?: () => void;
}

export interface StockEdits {
  run: (edit: StockEdit, onDone?: () => void) => Promise<void>;
  pending: boolean;
  error: string | null;
  // Set while the cook is asked whether to release Reservations.
  confirming: ReservedConfirm | null;
  confirm: () => Promise<void>;
  cancel: () => void;
}

// Updates and deletes Stock items. Lowering below what's reserved, or deleting
// an item with Reservations, comes back as STOCK_RESERVED: the edit waits for
// the cook's go-ahead, then goes again releasing the uncovered Reservations.
export function useStockEdits(): StockEdits {
  const utils = trpc.useUtils();
  const updateMutation = trpc.storage.update.useMutation();
  const deleteMutation = trpc.storage.delete.useMutation();
  const [confirming, setConfirming] = useState<ReservedConfirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Stays set until the list has refetched: the stepper sends an absolute
  // amount worked out from the list, so a tap on stale data would be lost.
  const [busy, setBusy] = useState(false);

  async function send(edit: StockEdit, release: boolean): Promise<void> {
    if (edit.kind === 'update') {
      await updateMutation.mutateAsync({
        ...edit.input,
        releaseReservations: release || undefined,
      });
    } else {
      await deleteMutation.mutateAsync({
        id: edit.id,
        releaseReservations: release || undefined,
      });
    }
  }

  async function attempt(
    edit: StockEdit,
    release: boolean,
    onDone?: () => void,
  ): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await send(edit, release);
      onDone?.();
    } catch (caught) {
      const cause = getDomainErrorCause(caught);
      if (cause?.code === 'STOCK_RESERVED' && !release) {
        setConfirming({ edit, onDone });
        return;
      }
      setError(
        cause?.code === 'STOCK_ITEM_NOT_FOUND'
          ? 'That item has already gone from storage.'
          : 'Couldn’t save that change. Try again.',
      );
    } finally {
      await utils.storage.list.invalidate();
      setBusy(false);
    }
  }

  return {
    run: (edit, onDone) => attempt(edit, false, onDone),
    pending: busy || updateMutation.isPending || deleteMutation.isPending,
    error,
    confirming,
    confirm: async () => {
      if (!confirming) return;
      const { edit, onDone } = confirming;
      setConfirming(null);
      await attempt(edit, true, onDone);
    },
    cancel: () => {
      setConfirming(null);
    },
  };
}
