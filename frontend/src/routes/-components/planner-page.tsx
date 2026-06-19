import type {
  PlanSlot,
  PlanSlotPairedRecipe,
  RecipeListItem,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { PlannerGrid } from '@/components/planner/planner-grid.tsx';
import { RecipeBank } from '@/components/planner/recipe-bank.tsx';
import { SlotEditorSheet } from '@/components/planner/slot-editor-sheet.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useOptimisticSlotUpdate } from '@/hooks/use-optimistic-slot-update.ts';
import { deriveBatchSupplyWarnings } from '@/lib/batch-supply.ts';
import { clampRange, formatDayRangeLabel } from '@/lib/date-utils.ts';
import { trpc } from '@/lib/trpc.ts';

export function PlannerPage(): React.ReactElement {
  const params = useParams({ from: '/_authed/plans/$planId' });
  const search = useSearch({ from: '/_authed/plans/$planId' });
  const planId = Number.parseInt(params.planId, 10);
  const idIsValid = Number.isInteger(planId) && planId > 0;

  const planQuery = trpc.plans.get.useQuery(
    { id: planId },
    { enabled: idIsValid },
  );
  const membersQuery = trpc.user.listHouseholdMembers.useQuery();

  const [selectedRecipe, setSelectedRecipe] = useState<RecipeListItem | null>(
    null,
  );
  const [editingSlotId, setEditingSlotId] = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { update, isPending } = useOptimisticSlotUpdate({
    planId,
    onError: (err) => {
      setMutationError(
        err instanceof Error ? err.message : 'Slot update failed',
      );
    },
  });

  const editingSlot = useMemo<PlanSlot | null>(() => {
    if (editingSlotId === null) return null;
    return (
      planQuery.data?.slots.find((slot) => slot.id === editingSlotId) ?? null
    );
  }, [editingSlotId, planQuery.data]);

  // One pass per plan render — recomputed when the cache mutates. The set
  // holds slot ids whose eating recipe is a batch-version (recipe.baseRecipeId
  // !== null) with no earlier-or-same base cook in this plan.
  const batchWarningSlots = useMemo(
    () =>
      planQuery.data
        ? deriveBatchSupplyWarnings(planQuery.data.slots)
        : new Set<number>(),
    [planQuery.data],
  );

  if (!idIsValid) {
    return <p role="alert">Invalid plan id.</p>;
  }
  if (planQuery.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading plan…
      </p>
    );
  }
  if (planQuery.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {planQuery.error.message}
      </p>
    );
  }
  if (!planQuery.data) return <p role="alert">Plan not found.</p>;

  const plan = planQuery.data;
  const visible = clampRange(
    plan.startDate,
    plan.endDate,
    search.start,
    search.end,
  );

  function handleSlotClick(slot: PlanSlot): void {
    if (slot.slotType === 'empty' && selectedRecipe) {
      // Two-tap assign — bank selection + empty slot tap.
      update({
        input: {
          slotId: slot.id,
          slotType: 'recipe',
          recipeId: selectedRecipe.id,
          numberOfServings: selectedRecipe.baseServings,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        },
        optimisticRecipe: {
          id: selectedRecipe.id,
          name: selectedRecipe.name,
          imageUrl: selectedRecipe.imageUrl,
          isBase: selectedRecipe.isBase,
          baseRecipeId: selectedRecipe.baseRecipeId,
          pairedRecipeId: selectedRecipe.pairedRecipeId,
          isDeleted: selectedRecipe.isDeleted,
        },
      });
      setSelectedRecipe(null);
      return;
    }
    // Anything else opens the editor sheet — including an empty slot when no
    // recipe is selected (lets the user pick a non-recipe state directly).
    setEditingSlotId(slot.id);
  }

  function handleSave(
    input: UpdateSlotInput,
    options?: {
      optimisticRecipe?: RecipeListItem;
      optimisticPairedRecipe?: PlanSlotPairedRecipe | null;
    },
  ): void {
    setMutationError(null);
    const optimisticRecipe = options?.optimisticRecipe;
    update({
      input,
      optimisticRecipe: optimisticRecipe
        ? {
            id: optimisticRecipe.id,
            name: optimisticRecipe.name,
            imageUrl: optimisticRecipe.imageUrl,
            isBase: optimisticRecipe.isBase,
            baseRecipeId: optimisticRecipe.baseRecipeId,
            pairedRecipeId: optimisticRecipe.pairedRecipeId,
            isDeleted: optimisticRecipe.isDeleted,
          }
        : undefined,
      optimisticPairedRecipe: options?.optimisticPairedRecipe,
    });
    setEditingSlotId(null);
  }

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4 lg:grid-cols-[16rem_1fr]">
      <div className="lg:max-h-[calc(100vh-6rem)] lg:overflow-hidden">
        <RecipeBank
          selectedRecipeId={selectedRecipe?.id ?? null}
          onSelect={setSelectedRecipe}
        />
      </div>
      <div className="space-y-4">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold">
            {formatDayRangeLabel(plan.startDate, plan.endDate)}
          </h1>
          <div className="flex items-center gap-3">
            {selectedRecipe && (
              <p className="text-sm text-muted-foreground" role="status">
                Tap an empty slot to assign “{selectedRecipe.name}”.
              </p>
            )}
            <Button asChild size="sm" variant="outline">
              <Link
                to="/plans/$planId/shopping"
                params={{ planId: String(plan.id) }}
              >
                Shopping list
              </Link>
            </Button>
          </div>
        </header>
        {mutationError && (
          <p role="alert" className="text-sm text-destructive">
            {mutationError}
          </p>
        )}
        {visible ? (
          <PlannerGrid
            slots={plan.slots}
            rangeStart={visible.start}
            rangeEnd={visible.end}
            warningSlotIds={batchWarningSlots}
            onSlotClick={handleSlotClick}
          />
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            The selected date range is outside this plan.
          </p>
        )}
      </div>
      <SlotEditorSheet
        open={editingSlot !== null}
        slot={editingSlot}
        members={membersQuery.data?.members ?? []}
        isSaving={isPending}
        hasBaseSupply={
          editingSlot === null || !batchWarningSlots.has(editingSlot.id)
        }
        onClose={() => {
          setEditingSlotId(null);
        }}
        onSave={handleSave}
      />
    </section>
  );
}
