import type {
  GetPlanResult,
  PlanSlot,
  PlanSlotItem,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { useRef } from 'react';

import { trpc } from '@/lib/trpc.ts';

// Canonical optimistic-update hook for slot mutations (cross-cutting #7). The
// meal editor and base modal both compose this rather than reimplementing the
// onMutate / onError / onSettled trio.
//
// Reconciliation uses `setQueryData` from the server response on settle, not a
// refetch — last-write-wins (DEC-36) treats whatever the server returned as
// canonical. A concurrent edit on a second client surfaces on the next
// `plans.get` mount.

export interface OptimisticSlotMutationOptions {
  planId: number;
  /**
   * Optional callback invoked when the server returns an error. Useful for
   * surfacing a toast or invoking the editor's error state.
   */
  onError?: (error: unknown) => void;
}

export interface OptimisticUpdateArgs {
  input: UpdateSlotInput;
  /**
   * Display items to render immediately — the editors know each picked
   * recipe's name/image, so they pass the full `PlanSlotItem[]` to preview the
   * slot before the server responds. The settle response replaces them with
   * the canonical rows. Omit for meta-only edits (status/chef/comment), which
   * keep the slot's current items.
   */
  optimisticItems?: PlanSlotItem[];
}

export interface UseOptimisticSlotUpdateResult {
  update: (args: OptimisticUpdateArgs) => void;
  isPending: boolean;
}

export function useOptimisticSlotUpdate({
  planId,
  onError,
}: OptimisticSlotMutationOptions): UseOptimisticSlotUpdateResult {
  const utils = trpc.useUtils();
  // Side channel: `mutate(input)` only forwards the input to `onMutate`, so the
  // optimistic items ride along through a ref. Mutations are user-driven and
  // sequential, so a ref is enough.
  const pendingOptimisticItems = useRef<PlanSlotItem[] | undefined>(undefined);

  const mutation = trpc.slots.update.useMutation({
    onMutate: async (input) => {
      await utils.plans.get.cancel({ id: planId });
      const previous = utils.plans.get.getData({ id: planId });
      if (!previous) {
        return { previous: undefined };
      }
      const itemsForOptimistic =
        pendingOptimisticItems.current ?? resolveExistingItems(previous, input);
      pendingOptimisticItems.current = undefined;
      const patched = applySlotPatch(previous, input, itemsForOptimistic);
      utils.plans.get.setData({ id: planId }, patched);
      return { previous };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.previous) {
        utils.plans.get.setData({ id: planId }, ctx.previous);
      }
      onError?.(err);
    },
    onSettled: (data) => {
      // Plant-points are derived from slot state — refetch after any slot
      // mutation so the per-day and plan-total badges reflect the new totals
      // (FEAT-41). The DAG: slots.update → plans.get cache patched in place
      // (LWW, no invalidate) + plants.* invalidated to drive a refetch.
      void utils.plants.forDay.invalidate({ planId });
      void utils.plants.forPlan.invalidate({ planId });
      // Swap the server-returned row into the cache without invalidating —
      // LWW reconciliation (DEC-36). The server result mirrors
      // `selectPlanSlots` exactly so the shape lines up.
      if (!data) return;
      const current = utils.plans.get.getData({ id: planId });
      if (!current) return;
      utils.plans.get.setData({ id: planId }, replaceSlot(current, data.slot));
    },
  });

  return {
    update: ({ input, optimisticItems }) => {
      pendingOptimisticItems.current = optimisticItems;
      mutation.mutate(input);
    },
    isPending: mutation.isPending,
  };
}

function applySlotPatch(
  plan: GetPlanResult,
  input: UpdateSlotInput,
  items: PlanSlotItem[],
): GetPlanResult {
  return {
    ...plan,
    slots: plan.slots.map((slot) =>
      slot.id === input.slotId
        ? {
            ...slot,
            slotType: input.slotType,
            chefUserId: input.chefUserId,
            comment: input.comment,
            items,
          }
        : slot,
    ),
  };
}

function replaceSlot(plan: GetPlanResult, serverSlot: PlanSlot): GetPlanResult {
  return {
    ...plan,
    slots: plan.slots.map((slot) =>
      slot.id === serverSlot.id ? serverSlot : slot,
    ),
  };
}

// Meta-only edits (status/chef/comment) don't pass optimistic items — keep the
// slot's current items so the card doesn't flicker empty until settle.
function resolveExistingItems(
  plan: GetPlanResult,
  input: UpdateSlotInput,
): PlanSlotItem[] {
  return plan.slots.find((slot) => slot.id === input.slotId)?.items ?? [];
}
