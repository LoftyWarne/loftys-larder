import type {
  HouseholdMember,
  PlanSlot,
  PlanSlotItem,
  RecipeListItem,
  SlotType,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { SLOT_COMMENT_MAX_LENGTH } from '@loftys-larder/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { RecipeTypeBadge } from '@/components/planner/recipe-type-badge.tsx';
import { ServingVariationWarning } from '@/components/planner/serving-variation-warning.tsx';
import {
  SearchableCombobox,
  type SearchableComboboxHandle,
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
import {
  deriveBaseBalances,
  itemConsumedBase,
} from '@/lib/serving-variation-supply.ts';
import { trpc } from '@/lib/trpc.ts';
import { cn } from '@/lib/utils.ts';

const SLOT_TYPE_OPTIONS: { value: SlotType; label: string }[] = [
  { value: 'recipe', label: 'Cooking' },
  { value: 'eat_out', label: 'Eat out' },
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'leftovers', label: 'Leftovers' },
  { value: 'empty', label: 'Empty' },
];

type SlotItemKind = PlanSlotItem['kind'];

interface RecipeOption extends SearchableComboboxOption {
  recipe: RecipeListItem;
}

// The minimal recipe shape the editor needs to add a dish — satisfied by both
// `RecipeListItem` (picker) and `Recipe` (the suggested-base fetch).
interface AddableRecipe {
  id: number;
  name: string;
  imageUrl: string | null;
  isBase: boolean;
  baseRecipeId: number | null;
  isDeleted: boolean;
  baseServings: number;
}

// One dish being edited. A base picked into the slot is a `cook_ahead` item; a
// variation or standalone is an `eat` item (the kind is derived from the
// recipe's type at pick time). `servings` is a string so the input round-trips
// what the user types.
interface EditorItem {
  recipeId: number;
  name: string;
  imageUrl: string | null;
  isBase: boolean;
  baseRecipeId: number | null;
  isDeleted: boolean;
  servings: string;
  kind: SlotItemKind;
}

interface EditorState {
  slotType: SlotType;
  chefUserId: string | null;
  comment: string;
  items: EditorItem[];
}

export interface SlotEditorSheetProps {
  open: boolean;
  slot: PlanSlot | null;
  members: readonly HouseholdMember[];
  isSaving: boolean;
  // Every slot in the plan, so base balances (shortfall + "left in plan") can
  // be recomputed live against this slot's in-progress edits.
  slots: readonly PlanSlot[];
  onClose: () => void;
  onSave: (
    input: UpdateSlotInput,
    options?: { optimisticItems?: PlanSlotItem[] },
  ) => void;
}

function toEditorItem(recipe: AddableRecipe, kind: SlotItemKind): EditorItem {
  return {
    recipeId: recipe.id,
    name: recipe.name,
    imageUrl: recipe.imageUrl,
    isBase: recipe.isBase,
    baseRecipeId: recipe.baseRecipeId,
    isDeleted: recipe.isDeleted,
    servings: String(recipe.baseServings),
    kind,
  };
}

export function SlotEditorSheet({
  open,
  slot,
  members,
  isSaving,
  slots,
  onClose,
  onSave,
}: SlotEditorSheetProps): React.ReactElement | null {
  const formId = useId();
  const [state, setState] = useState<EditorState | null>(null);
  const [isAddingDish, setIsAddingDish] = useState(false);
  const comboboxRef = useRef<SearchableComboboxHandle>(null);

  useEffect(() => {
    if (!slot) {
      setState(null);
      return;
    }
    setIsAddingDish(false);
    setState({
      slotType: slot.slotType,
      chefUserId: slot.chefUserId,
      comment: slot.comment ?? '',
      items: slot.items.map((item) => ({
        recipeId: item.recipeId,
        name: item.recipeName,
        imageUrl: item.recipeImageUrl,
        isBase: item.isBase,
        baseRecipeId: item.baseRecipeId,
        isDeleted: item.isDeleted,
        servings: String(item.servings),
        kind: item.kind,
      })),
    });
  }, [slot]);

  // Focus the dish search as soon as it's revealed so the user can type
  // straight away after pressing "Add another dish".
  useEffect(() => {
    if (isAddingDish) comboboxRef.current?.focus();
  }, [isAddingDish]);

  const utils = trpc.useUtils();

  // Suggest cooking the base behind an eaten variation when it isn't already a
  // cook-ahead in this slot (carried over from the old base modal). Computed
  // from the live editor items so it tracks what the user is adding.
  const eatItems = state?.items.filter((it) => it.kind === 'eat') ?? [];
  const cookItems = state?.items.filter((it) => it.kind === 'cook_ahead') ?? [];
  const suggestedBaseRecipeId =
    eatItems
      .map(itemConsumedBase)
      .find((id) => id !== null && !cookItems.some((c) => c.recipeId === id)) ??
    null;
  const showSuggestion = state !== null && suggestedBaseRecipeId !== null;
  const suggestionQuery = trpc.recipes.get.useQuery(
    { id: suggestedBaseRecipeId ?? 0 },
    { enabled: showSuggestion },
  );

  // Recompute base balances against this slot's live edits — splice the
  // in-progress items into the plan in place of the saved slot so the
  // shortfall warning and "left in plan" track what the user is adding, not
  // the last-saved state. Dishes only count on a "Cooking" slot.
  const liveBalances = useMemo(() => {
    if (!slot || !state) return null;
    const liveItems: PlanSlotItem[] =
      state.slotType === 'recipe'
        ? state.items.map((item, index) => ({
            id: index + 1,
            recipeId: item.recipeId,
            recipeName: item.name,
            recipeImageUrl: item.imageUrl,
            isBase: item.isBase,
            baseRecipeId: item.baseRecipeId,
            isDeleted: item.isDeleted,
            servings: Number.parseInt(item.servings, 10) || 0,
            kind: item.kind,
            sortOrder: index,
          }))
        : [];
    return deriveBaseBalances([
      ...slots.filter((s) => s.id !== slot.id),
      { ...slot, slotType: state.slotType, items: liveItems },
    ]);
  }, [slots, slot, state]);

  if (!slot || !state) return null;

  const shortBy = liveBalances?.shortfallBySlot.get(slot.id);
  const remainingByBase = liveBalances?.remainingByBase;

  function addRecipe(recipe: AddableRecipe, kind: SlotItemKind): void {
    setState((prev) => {
      if (!prev) return prev;
      // Guard against duplicates — the same recipe can't appear twice in one
      // slot, in either role.
      if (prev.items.some((it) => it.recipeId === recipe.id)) return prev;
      return { ...prev, items: [...prev.items, toEditorItem(recipe, kind)] };
    });
  }

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!slot || !state) return;
    const built = buildInputForSave(slot, state);
    if (!built) return;
    onSave(built.input, { optimisticItems: built.optimisticItems });
  }

  function handleClear(): void {
    if (!slot) return;
    // Empties the slot entirely — meal dishes and base cooks are both edited
    // here now, so there's nothing to preserve.
    onSave(
      {
        slotId: slot.id,
        slotType: 'empty',
        chefUserId: null,
        comment: null,
        items: [],
      },
      { optimisticItems: [] },
    );
  }

  const showDishes = state.slotType === 'recipe';
  const showAdder = isAddingDish || state.items.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className={cn(
          'left-0 right-0 top-auto bottom-0 max-w-none translate-x-0 translate-y-0 rounded-t-lg rounded-b-none sm:bottom-auto sm:left-[50%] sm:right-auto sm:top-[50%] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg',
        )}
      >
        <DialogHeader>
          <DialogTitle>
            {slot.occasionName} · {formatLongDayLabel(slot.date)}
          </DialogTitle>
          <DialogDescription>
            Set what you&apos;re eating or prepping in this slot.
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Slot type</legend>
            <div className="flex flex-wrap gap-2">
              {SLOT_TYPE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'flex cursor-pointer items-center gap-1 rounded-md border border-input px-3 py-1 text-sm transition',
                    state.slotType === option.value &&
                      'border-primary bg-accent',
                  )}
                >
                  <input
                    type="radio"
                    name="slotType"
                    value={option.value}
                    checked={state.slotType === option.value}
                    onChange={() => {
                      setState((prev) =>
                        prev ? { ...prev, slotType: option.value } : prev,
                      );
                    }}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {showDishes && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Dishes</legend>
              {state.items.length > 0 && (
                <div className="grid grid-cols-[minmax(0,1fr)_4rem_2rem] items-center gap-x-2 rounded-md border border-border">
                  <div className="col-span-full grid grid-cols-subgrid items-center border-b border-border px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      Dish
                    </span>
                    <span className="text-xs font-medium text-muted-foreground">
                      Servings
                    </span>
                    <span aria-hidden="true" />
                  </div>
                  {state.items.map((item, index) => {
                    const remaining =
                      item.kind === 'cook_ahead'
                        ? remainingByBase?.get(item.recipeId)
                        : undefined;
                    return (
                      <div
                        key={`${String(item.recipeId)}:${String(index)}`}
                        className="col-span-full grid grid-cols-subgrid items-center px-3 py-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border"
                        data-testid="dish-item-row"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate text-sm">
                            {item.kind === 'cook_ahead' && '🍲 '}
                            {item.name}
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
                          <RecipeTypeBadge recipe={item} className="ml-auto" />
                        </div>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          value={item.servings}
                          aria-label={`Servings for ${item.name}`}
                          onChange={(event) => {
                            const value = event.target.value;
                            setState((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    items: prev.items.map((it, i) =>
                                      i === index
                                        ? { ...it, servings: value }
                                        : it,
                                    ),
                                  }
                                : prev,
                            );
                          }}
                          required
                          className="w-full"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${item.name}`}
                          className="w-8 shrink-0 px-0"
                          onClick={() => {
                            setState((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    items: prev.items.filter(
                                      (_, i) => i !== index,
                                    ),
                                  }
                                : prev,
                            );
                          }}
                        >
                          ×
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
              {showAdder ? (
                <SearchableCombobox<RecipeOption>
                  ref={comboboxRef}
                  value={null}
                  onChange={(option) => {
                    if (!option) return;
                    addRecipe(
                      option.recipe,
                      option.recipe.isBase ? 'cook_ahead' : 'eat',
                    );
                    // Collapse back to the "Add another dish" button, which
                    // also clears the search text by unmounting the input.
                    setIsAddingDish(false);
                  }}
                  searchQuery={async (query) => {
                    const result = await utils.recipes.list.fetch({
                      search: query || undefined,
                      includePickerHidden: true,
                      limit: 20,
                    });
                    const chosen = new Set(
                      state.items.map((it) => it.recipeId),
                    );
                    return result.items
                      .filter((recipe) => !chosen.has(recipe.id))
                      .map((recipe) => ({
                        id: recipe.id,
                        label: recipe.name,
                        recipe,
                      }));
                  }}
                  renderOption={(option) => (
                    <span className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{option.label}</span>
                      <RecipeTypeBadge recipe={option.recipe} />
                    </span>
                  )}
                  ariaLabel="Add a dish"
                  placeholder="Add a dish"
                />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    setIsAddingDish(true);
                  }}
                >
                  Add another dish
                </Button>
              )}

              {showSuggestion && suggestionQuery.data && (
                <button
                  type="button"
                  data-testid="base-suggestion-hint"
                  onClick={() => {
                    addRecipe(suggestionQuery.data, 'cook_ahead');
                  }}
                  className="self-start rounded-md border border-dashed border-primary px-2 py-1 text-xs text-primary hover:bg-accent"
                >
                  Suggested: {suggestionQuery.data.name} — cook this?
                </button>
              )}

              {shortBy !== undefined && shortBy > 0 && (
                <ServingVariationWarning shortBy={shortBy} />
              )}
            </fieldset>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Chef</span>
            <select
              value={state.chefUserId ?? ''}
              onChange={(event) => {
                setState((prev) =>
                  prev
                    ? {
                        ...prev,
                        chefUserId:
                          event.target.value === '' ? null : event.target.value,
                      }
                    : prev,
                );
              }}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Unassigned</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Comment</span>
            <textarea
              value={state.comment}
              onChange={(event) => {
                setState((prev) =>
                  prev ? { ...prev, comment: event.target.value } : prev,
                );
              }}
              maxLength={SLOT_COMMENT_MAX_LENGTH}
              rows={3}
              className="rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={handleClear}
            disabled={isSaving}
          >
            Clear
          </Button>
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
  state: EditorState,
): BuiltSave | null {
  const trimmedComment = state.comment.trim();
  const commentValue = trimmedComment === '' ? null : trimmedComment;

  // Dishes only belong to a "Cooking" slot; any other type clears them.
  const items = state.slotType === 'recipe' ? state.items : [];
  const parsed: { item: EditorItem; servings: number }[] = [];
  for (const item of items) {
    const servings = Number.parseInt(item.servings, 10);
    if (!Number.isInteger(servings) || servings <= 0) return null;
    parsed.push({ item, servings });
  }

  const input: UpdateSlotInput = {
    slotId: slot.id,
    slotType: state.slotType,
    chefUserId: state.chefUserId,
    comment: commentValue,
    items: parsed.map(({ item, servings }, index) => ({
      recipeId: item.recipeId,
      servings,
      kind: item.kind,
      sortOrder: index,
    })),
  };

  const optimisticItems: PlanSlotItem[] = parsed.map(
    ({ item, servings }, index) => ({
      id: index + 1,
      recipeId: item.recipeId,
      recipeName: item.name,
      recipeImageUrl: item.imageUrl,
      isBase: item.isBase,
      baseRecipeId: item.baseRecipeId,
      isDeleted: item.isDeleted,
      servings,
      kind: item.kind,
      sortOrder: index,
    }),
  );

  return { input, optimisticItems };
}
