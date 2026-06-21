import type {
  GetShoppingListForPlanResult,
  ToggleShoppingItemCheckedInput,
} from '@loftys-larder/shared';

import {
  getOfflineQueueStore,
  type OfflineQueueStore,
} from '@/lib/offline-queue.ts';
import { trpc } from '@/lib/trpc.ts';

// Sibling of `useOptimisticSlotUpdate` (cross-cutting #7) for the shopping
// list's check toggles. The slot hook's preview args are plan-DTO-shaped, so
// rather than generalise, the shopping path runs through its own hook with the
// same `onMutate` / `onError` / `onSettled` skeleton — server-truth on settle,
// no invalidation (DEC-36 LWW). When the mutation fails because the browser
// is offline (`navigator.onLine === false`) we keep the optimistic patch and
// enqueue the input for reconnect-drain (FEAT-43) instead of rolling back —
// online failures keep the rollback path.

export interface OptimisticCheckToggleOptions {
  planId: number;
  /**
   * Surface the mutation error to the page — caller renders an inline message
   * the same way `PlannerPage` does for slot mutations. Suppressed when the
   * failure is recognised as an offline-only network error.
   */
  onError?: (error: unknown) => void;
  /**
   * Override the queue store (test seam). Defaults to the shared singleton.
   */
  offlineQueueStore?: OfflineQueueStore;
}

export interface UseOptimisticCheckToggleResult {
  toggle: (input: ToggleShoppingItemCheckedInput) => void;
  isPending: boolean;
}

function isOffline(): boolean {
  if (typeof navigator === 'undefined') return false;
  return !navigator.onLine;
}

export function useOptimisticCheckToggle({
  planId,
  onError,
  offlineQueueStore,
}: OptimisticCheckToggleOptions): UseOptimisticCheckToggleResult {
  const utils = trpc.useUtils();
  const store = offlineQueueStore ?? getOfflineQueueStore();

  const mutation = trpc.shopping.toggleChecked.useMutation({
    onMutate: async (input) => {
      await utils.shopping.getForPlan.cancel({ planId });
      const previous = utils.shopping.getForPlan.getData({ planId });
      if (!previous) {
        return { previous: undefined };
      }
      utils.shopping.getForPlan.setData(
        { planId },
        applyCheckPatch(previous, input.ingredientId, input.isChecked),
      );
      return { previous };
    },
    onError: (err, input, ctx) => {
      if (isOffline()) {
        // Keep the optimistic patch; queue the toggle for reconnect-drain.
        void store.enqueue({
          planId: input.planId,
          ingredientId: input.ingredientId,
          isChecked: input.isChecked,
        });
        return;
      }
      if (ctx?.previous) {
        utils.shopping.getForPlan.setData({ planId }, ctx.previous);
      }
      onError?.(err);
    },
    onSuccess: (_data, input) => {
      // Successful mutation supersedes any queued entry for the same line —
      // protects against a live toggle racing the reconnect-drain.
      void store.remove(input.planId, input.ingredientId);
    },
    onSettled: (data) => {
      // The server response only carries `{ planId, ingredientId, isChecked }`
      // — enough to reconcile the one line without a refetch (DEC-36 LWW).
      if (!data) return;
      const current = utils.shopping.getForPlan.getData({ planId });
      if (!current) return;
      utils.shopping.getForPlan.setData(
        { planId },
        applyCheckPatch(current, data.ingredientId, data.isChecked),
      );
    },
  });

  return {
    toggle: (input) => {
      mutation.mutate(input);
    },
    isPending: mutation.isPending,
  };
}

function applyCheckPatch(
  list: GetShoppingListForPlanResult,
  ingredientId: number,
  isChecked: boolean,
): GetShoppingListForPlanResult {
  return {
    ...list,
    categories: list.categories.map((cat) => ({
      ...cat,
      lines: cat.lines.map((line) =>
        line.ingredient.id === ingredientId ? { ...line, isChecked } : line,
      ),
    })),
  };
}
