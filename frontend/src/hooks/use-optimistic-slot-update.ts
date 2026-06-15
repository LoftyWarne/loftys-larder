import type {
  GetPlanResult,
  PlanSlot,
  PlanSlotRecipe,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { useRef } from 'react';

import { trpc } from '@/lib/trpc.ts';

// Canonical optimistic-update hook for slot mutations (cross-cutting #7). Other
// slot-related mutations (FEAT-32 base-cook fields, FEAT-33 chef, etc.) compose
// this rather than reimplementing the onMutate / onError / onSettled trio.
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
   * Preview recipe — typically the row picked from the bank — used to render
   * the assigned recipe's name/image immediately. The server response on
   * settle replaces this with the canonical row from `plans.get`'s shape.
   * Omit when the recipe isn't changing (servings/chef/comment edit).
   */
  optimisticRecipe?: PlanSlotRecipe;
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
  // Side channel: `mutate(input)` only forwards the input to `onMutate`, so
  // the optimistic-recipe preview is dropped through a ref. Mutations are
  // user-driven and sequential — no overlap between a `mutate` call and the
  // adjacent `onMutate` runtime — so a ref is enough.
  const pendingOptimisticRecipe = useRef<PlanSlotRecipe | undefined>(undefined);

  const mutation = trpc.slots.update.useMutation({
    onMutate: async (input) => {
      await utils.plans.get.cancel({ id: planId });
      const previous = utils.plans.get.getData({ id: planId });
      if (!previous) {
        return { previous: undefined };
      }
      const recipeForOptimistic =
        pendingOptimisticRecipe.current ??
        resolveExistingRecipe(previous, input);
      pendingOptimisticRecipe.current = undefined;
      const patched = applySlotPatch(previous, input, recipeForOptimistic);
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
    update: ({ input, optimisticRecipe }) => {
      pendingOptimisticRecipe.current = optimisticRecipe;
      mutation.mutate(input);
    },
    isPending: mutation.isPending,
  };
}

function applySlotPatch(
  plan: GetPlanResult,
  input: UpdateSlotInput,
  recipe: PlanSlotRecipe | null,
): GetPlanResult {
  return {
    ...plan,
    slots: plan.slots.map((slot) =>
      slot.id === input.slotId
        ? {
            ...slot,
            slotType: input.slotType,
            recipeId: input.recipeId,
            numberOfServings: input.numberOfServings,
            chefUserId: input.chefUserId,
            comment: input.comment,
            recipe,
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

// If the input keeps the existing recipe (servings/chef/comment edit), reuse
// the stored sub-object so the card doesn't lose the recipe's name/image.
function resolveExistingRecipe(
  plan: GetPlanResult,
  input: UpdateSlotInput,
): PlanSlotRecipe | null {
  if (input.slotType !== 'recipe' || input.recipeId === null) {
    return null;
  }
  const existing = plan.slots.find((slot) => slot.id === input.slotId);
  if (existing?.recipe?.id === input.recipeId) {
    return existing.recipe;
  }
  return null;
}
