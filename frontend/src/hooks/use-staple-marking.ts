import type { UpdateIngredientInput } from '@loftys-larder/shared';
import { useState } from 'react';

import { getDomainErrorCause } from '@/lib/domain-error.ts';
import { trpc } from '@/lib/trpc.ts';

export interface StapleStockConfirmation {
  name: string;
  stockItems: number;
  reservations: number;
}

interface Pending extends StapleStockConfirmation {
  input: UpdateIngredientInput;
  onSaved: () => void;
}

export interface StapleMarking {
  // Saves an ingredient edit. If it would mark a held ingredient as a Staple,
  // it stops and asks first (`confirming`). Other errors are thrown.
  save: (
    input: UpdateIngredientInput,
    name: string,
    onSaved: () => void,
  ) => Promise<void>;
  confirming: StapleStockConfirmation | null;
  confirm: () => Promise<void>;
  cancel: () => void;
  isPending: boolean;
  error: string | null;
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

// A Staple is never a Stock item (DEC-118), so marking a held ingredient as
// one deletes its Stock items once the cook agrees.
export function useStapleMarking(): StapleMarking {
  const utils = trpc.useUtils();
  const mutation = trpc.ingredients.update.useMutation();
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    await Promise.all([
      utils.ingredients.list.invalidate(),
      utils.storage.list.invalidate(),
      utils.shopping.getForPlan.invalidate(),
    ]);
  }

  async function save(
    input: UpdateIngredientInput,
    name: string,
    onSaved: () => void,
  ): Promise<void> {
    try {
      await mutation.mutateAsync(input);
    } catch (caught) {
      const cause = getDomainErrorCause(caught);
      if (cause?.code === 'INGREDIENT_STAPLE_HAS_STOCK') {
        setError(null);
        setPending({
          input,
          onSaved,
          name,
          stockItems: count(cause.stockItems),
          reservations: count(cause.reservations),
        });
        return;
      }
      throw caught;
    }
    await refresh();
    onSaved();
  }

  async function confirm(): Promise<void> {
    if (!pending) return;
    try {
      await mutation.mutateAsync({ ...pending.input, deleteStock: true });
    } catch {
      setError('Couldn’t make it a Staple. Try again.');
      return;
    }
    const { onSaved } = pending;
    setPending(null);
    await refresh();
    onSaved();
  }

  return {
    save,
    confirming: pending,
    confirm,
    cancel: () => {
      setPending(null);
      setError(null);
    },
    isPending: mutation.isPending,
    error,
  };
}
