import type {
  GetShoppingListForPlanResult,
  ToggleShoppingItemCheckedInput,
} from '@loftys-larder/shared';

import { trpc } from '@/lib/trpc.ts';

// Sibling of `useOptimisticSlotUpdate` (cross-cutting #7) for the shopping
// list's check toggles. The slot hook's preview args are plan-DTO-shaped, so
// rather than generalise, the shopping path runs through its own hook with the
// same `onMutate` / `onError` / `onSettled` skeleton — server-truth on settle,
// no invalidation (DEC-36 LWW). The offline mutation queue (FEAT-43) will
// extend this hook by adding a persistence layer.

export interface OptimisticCheckToggleOptions {
  planId: number;
  /**
   * Surface the mutation error to the page — caller renders an inline message
   * the same way `PlannerPage` does for slot mutations.
   */
  onError?: (error: unknown) => void;
}

export interface UseOptimisticCheckToggleResult {
  toggle: (input: ToggleShoppingItemCheckedInput) => void;
  isPending: boolean;
}

export function useOptimisticCheckToggle({
  planId,
  onError,
}: OptimisticCheckToggleOptions): UseOptimisticCheckToggleResult {
  const utils = trpc.useUtils();

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
    onError: (err, _input, ctx) => {
      if (ctx?.previous) {
        utils.shopping.getForPlan.setData({ planId }, ctx.previous);
      }
      onError?.(err);
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
