import type {
  PlanSlot,
  PlanSlotItem,
  RecipeListItem,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { useEffect, useId, useState } from 'react';

import { ServingVariationWarning } from '@/components/planner/serving-variation-warning.tsx';
import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { formatLongDayLabel } from '@/lib/date-utils.ts';
import { itemConsumedBase } from '@/lib/serving-variation-supply.ts';
import { trpc } from '@/lib/trpc.ts';

interface RecipeOption extends SearchableComboboxOption {
  recipe: RecipeListItem;
}

interface EditorCookItem {
  recipeId: number;
  name: string;
  isDeleted: boolean;
  servings: string;
}

export interface BaseCookSheetProps {
  open: boolean;
  slot: PlanSlot | null;
  // End-of-plan remaining cooked base per base recipe id (from
  // `deriveBaseBalances`), used to show how much base is left over.
  remainingByBase: ReadonlyMap<number, number>;
  // How many base servings this slot's meals run short by, if any.
  shortBy?: number;
  isSaving: boolean;
  onClose: () => void;
  onSave: (
    input: UpdateSlotInput,
    options?: { optimisticItems?: PlanSlotItem[] },
  ) => void;
}

export function BaseCookSheet({
  open,
  slot,
  remainingByBase,
  shortBy,
  isSaving,
  onClose,
  onSave,
}: BaseCookSheetProps): React.ReactElement | null {
  const formId = useId();
  const [cookItems, setCookItems] = useState<EditorCookItem[] | null>(null);

  useEffect(() => {
    if (!slot) {
      setCookItems(null);
      return;
    }
    setCookItems(
      slot.items
        .filter((item) => item.kind === 'cook_ahead')
        .map((item) => ({
          recipeId: item.recipeId,
          name: item.recipeName,
          isDeleted: item.isDeleted,
          servings: String(item.servings),
        })),
    );
  }, [slot]);

  const utils = trpc.useUtils();

  // The base this slot's first eaten dish draws on — eating a variation offers
  // its base, eating a base itself offers that base. One tap to cook it.
  const suggestedBaseRecipeId = slot
    ? (slot.items
        .filter((item) => item.kind === 'eat')
        .map(itemConsumedBase)
        .find((id) => id !== null) ?? null)
    : null;
  const alreadyCooking =
    cookItems?.some((item) => item.recipeId === suggestedBaseRecipeId) ?? false;
  const showSuggestion =
    cookItems !== null && suggestedBaseRecipeId !== null && !alreadyCooking;
  const suggestionQuery = trpc.recipes.get.useQuery(
    suggestedBaseRecipeId === null ? { id: 0 } : { id: suggestedBaseRecipeId },
    { enabled: showSuggestion },
  );

  if (!slot || !cookItems) return null;

  function addCook(recipe: {
    id: number;
    name: string;
    baseServings: number;
  }): void {
    setCookItems((prev) =>
      prev
        ? [
            ...prev,
            {
              recipeId: recipe.id,
              name: recipe.name,
              isDeleted: false,
              servings: String(recipe.baseServings),
            },
          ]
        : prev,
    );
  }

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!slot || !cookItems) return;
    const built = buildInputForSave(slot, cookItems);
    if (!built) return;
    onSave(built.input, { optimisticItems: built.optimisticItems });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="left-0 right-0 top-auto bottom-0 max-w-none translate-x-0 translate-y-0 rounded-t-lg rounded-b-none sm:bottom-auto sm:left-[50%] sm:right-auto sm:top-[50%] sm:max-w-md sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg">
        <DialogHeader>
          <DialogTitle>Cook a base</DialogTitle>
          <DialogDescription>
            {slot.occasionName} · {formatLongDayLabel(slot.date)} — prep bases
            in bulk; later meals draw on them.
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
        >
          {cookItems.map((item, index) => {
            const remaining = remainingByBase.get(item.recipeId);
            return (
              <div
                key={`${String(item.recipeId)}:${String(index)}`}
                className="flex items-end gap-2"
                data-testid="cook-item-row"
              >
                <span className="flex-1 text-sm">
                  🍲 {item.name}
                  {item.isDeleted && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      (deleted)
                    </span>
                  )}
                  {remaining !== undefined && (
                    <span
                      className="ml-1 text-xs text-muted-foreground"
                      data-testid="base-remaining"
                    >
                      ({String(remaining)} left in plan)
                    </span>
                  )}
                </span>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium">Servings</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={item.servings}
                    aria-label={`Base servings for ${item.name}`}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCookItems((prev) =>
                        prev
                          ? prev.map((it, i) =>
                              i === index ? { ...it, servings: value } : it,
                            )
                          : prev,
                      );
                    }}
                    required
                    className="w-20"
                  />
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => {
                    setCookItems((prev) =>
                      prev ? prev.filter((_, i) => i !== index) : prev,
                    );
                  }}
                >
                  ×
                </Button>
              </div>
            );
          })}

          {showSuggestion && suggestionQuery.data && (
            <button
              type="button"
              data-testid="base-suggestion-hint"
              onClick={() => {
                addCook(suggestionQuery.data);
              }}
              className="self-start rounded-md border border-dashed border-primary px-2 py-1 text-xs text-primary hover:bg-accent"
            >
              Suggested: {suggestionQuery.data.name} — cook this?
            </button>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Add a base</span>
            <SearchableCombobox<RecipeOption>
              value={null}
              onChange={(option) => {
                if (option) addCook(option.recipe);
              }}
              searchQuery={async (query) => {
                const result = await utils.recipes.list.fetch({
                  search: query || undefined,
                  isBase: true,
                  includePickerHidden: true,
                  limit: 20,
                });
                return result.items.map((recipe) => ({
                  id: recipe.id,
                  label: recipe.name,
                  recipe,
                }));
              }}
              ariaLabel="Search base recipe"
              placeholder="Search base recipe"
            />
          </label>

          {shortBy !== undefined && shortBy > 0 && (
            <ServingVariationWarning shortBy={shortBy} />
          )}
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface BuiltSave {
  input: UpdateSlotInput;
  optimisticItems: PlanSlotItem[];
}

function buildInputForSave(
  slot: PlanSlot,
  cookItems: EditorCookItem[],
): BuiltSave | null {
  // The base modal owns the `cook_ahead` items; the slot's `eat` items are
  // edited in the Meal editor and preserved verbatim here.
  const eat = slot.items.filter((item) => item.kind === 'eat');

  const parsed: { item: EditorCookItem; servings: number }[] = [];
  for (const item of cookItems) {
    const servings = Number.parseInt(item.servings, 10);
    if (!Number.isInteger(servings) || servings <= 0) return null;
    parsed.push({ item, servings });
  }

  const input: UpdateSlotInput = {
    slotId: slot.id,
    slotType: slot.slotType,
    chefUserId: slot.chefUserId,
    comment: slot.comment,
    items: [
      ...eat.map((item, index) => ({
        recipeId: item.recipeId,
        servings: item.servings,
        kind: 'eat' as const,
        sortOrder: index,
      })),
      ...parsed.map(({ item, servings }, index) => ({
        recipeId: item.recipeId,
        servings,
        kind: 'cook_ahead' as const,
        sortOrder: eat.length + index,
      })),
    ],
  };

  const optimisticItems: PlanSlotItem[] = [
    ...eat.map((item, index) => ({ ...item, id: index + 1, sortOrder: index })),
    ...parsed.map(({ item, servings }, index) => ({
      id: eat.length + index + 1,
      recipeId: item.recipeId,
      recipeName: item.name,
      recipeImageUrl: null,
      isBase: true,
      baseRecipeId: null,
      isDeleted: item.isDeleted,
      servings,
      kind: 'cook_ahead' as const,
      sortOrder: eat.length + index,
    })),
  ];

  return { input, optimisticItems };
}
