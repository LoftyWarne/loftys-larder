import type {
  GetPlanResult,
  PlanSlot,
  PlanSlotPairedRecipe,
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
  /**
   * Preview paired-recipe sub-object — used by the pair-switch flow to keep
   * the switch affordance live during the optimistic window. After a switch,
   * the destination recipe's pair points back at the original, so the caller
   * knows this without an extra fetch. Omit when the recipe isn't changing.
   */
  optimisticPairedRecipe?: PlanSlotPairedRecipe | null;
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
  // Same side-channel trick for the paired-recipe preview: callers pass the
  // pair affordance's destination so the button stays in the right state
  // until settle. `undefined` = "no opinion, reuse existing"; `null` = "no
  // pair on this recipe".
  const pendingOptimisticPaired = useRef<
    PlanSlotPairedRecipe | null | undefined
  >(undefined);

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
      const pairedForOptimistic =
        pendingOptimisticPaired.current !== undefined
          ? pendingOptimisticPaired.current
          : resolveExistingPaired(previous, input);
      pendingOptimisticRecipe.current = undefined;
      pendingOptimisticPaired.current = undefined;
      const patched = applySlotPatch(
        previous,
        input,
        recipeForOptimistic,
        pairedForOptimistic,
      );
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
    update: ({ input, optimisticRecipe, optimisticPairedRecipe }) => {
      pendingOptimisticRecipe.current = optimisticRecipe;
      pendingOptimisticPaired.current = optimisticPairedRecipe;
      mutation.mutate(input);
    },
    isPending: mutation.isPending,
  };
}

function applySlotPatch(
  plan: GetPlanResult,
  input: UpdateSlotInput,
  recipe: PlanSlotRecipe | null,
  pairedRecipe: PlanSlotPairedRecipe | null,
): GetPlanResult {
  return {
    ...plan,
    slots: plan.slots.map((slot) => {
      if (slot.id !== input.slotId) return slot;
      // Preserve the existing cooked-base sub-object when the base FK is
      // unchanged so the card keeps rendering its name during the optimistic
      // window; otherwise null it and let the server fill in the name on
      // settle.
      const cooksBaseRecipe =
        input.cooksBaseRecipeId !== null &&
        input.cooksBaseRecipeId === slot.cooksBaseRecipeId
          ? slot.cooksBaseRecipe
          : null;
      return {
        ...slot,
        slotType: input.slotType,
        recipeId: input.recipeId,
        numberOfServings: input.numberOfServings,
        chefUserId: input.chefUserId,
        cooksBaseRecipeId: input.cooksBaseRecipeId,
        cooksBaseServings: input.cooksBaseServings,
        comment: input.comment,
        recipe,
        cooksBaseRecipe,
        pairedRecipe,
      };
    }),
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

// Sibling of `resolveExistingRecipe`: when the caller doesn't pass an
// `optimisticPairedRecipe`, reuse the stored sub-object if the recipe FK is
// unchanged so the pair-switch affordance doesn't blink off during a
// servings/chef/comment edit.
function resolveExistingPaired(
  plan: GetPlanResult,
  input: UpdateSlotInput,
): PlanSlotPairedRecipe | null {
  if (input.slotType !== 'recipe' || input.recipeId === null) {
    return null;
  }
  const existing = plan.slots.find((slot) => slot.id === input.slotId);
  if (existing?.recipe?.id === input.recipeId) {
    return existing.pairedRecipe;
  }
  return null;
}
