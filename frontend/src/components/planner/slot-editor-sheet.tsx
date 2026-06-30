import type {
  HouseholdMember,
  LeftoversSource,
  PlanSlot,
  PlanSlotItem,
  RecipeListItem,
  SlotType,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import {
  compareOccasionByName,
  SLOT_COMMENT_MAX_LENGTH,
} from '@loftys-larder/shared';
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
  // Set only when slotType is `leftovers`. `plan_meal` pairs with a single
  // `eat` item in `items` (the dish being eaten); `takeaway` / `other` clear it.
  leftoversSource: LeftoversSource | null;
  chefUserId: string | null;
  comment: string;
  items: EditorItem[];
  // Who's eating: ids of the household members present.
  dinerUserIds: string[];
  // Accountless diners (kids, guests). String for input round-trip, like
  // `servings`.
  guestCount: string;
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

function toEditorItem(
  recipe: AddableRecipe,
  kind: SlotItemKind,
  defaultServings: number,
): EditorItem {
  return {
    recipeId: recipe.id,
    name: recipe.name,
    imageUrl: recipe.imageUrl,
    isBase: recipe.isBase,
    baseRecipeId: recipe.baseRecipeId,
    isDeleted: recipe.isDeleted,
    servings: String(defaultServings),
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
      leftoversSource: slot.leftoversSource,
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
      dinerUserIds: [...slot.dinerUserIds],
      guestCount: String(slot.guestCount),
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
  // Meals prepared on earlier "Cooking" slots in this plan — the leftovers
  // picker's plan-meal options. Deduped by recipe so a dish that recurs lists
  // once. "Earlier" is (date, occasion) order, matching the consumption walk.
  const earlierMeals = useMemo(() => {
    if (!slot) return [];
    const byRecipe = new Map<number, PlanSlotItem>();
    for (const candidate of slots) {
      if (candidate.slotType !== 'recipe') continue;
      if (!isSlotBefore(candidate, slot)) continue;
      for (const item of candidate.items) {
        if (!byRecipe.has(item.recipeId)) byRecipe.set(item.recipeId, item);
      }
    }
    return [...byRecipe.values()];
  }, [slots, slot]);

  const liveBalances = useMemo(() => {
    if (!slot || !state) return null;
    // A leftovers-of-a-plan-meal slot draws the base pool down too, so its one
    // eat item counts here exactly like a Cooking slot's dishes.
    const itemsCount =
      state.slotType === 'recipe' ||
      (state.slotType === 'leftovers' && state.leftoversSource === 'plan_meal');
    const liveItems: PlanSlotItem[] = itemsCount
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
  const headcount = headcountOf(state);

  function addRecipe(recipe: AddableRecipe, kind: SlotItemKind): void {
    setState((prev) => {
      if (!prev) return prev;
      // Guard against duplicates — the same recipe can't appear twice in one
      // slot, in either role.
      if (prev.items.some((it) => it.recipeId === recipe.id)) return prev;
      // An `eat` dish feeds the table, so default it to the headcount when one
      // is set; a `cook_ahead` base is a batch, so keep its own base servings.
      const headcount = headcountOf(prev);
      const defaultServings =
        kind === 'eat' && headcount > 0 ? headcount : recipe.baseServings;
      return {
        ...prev,
        items: [...prev.items, toEditorItem(recipe, kind, defaultServings)],
      };
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
        leftoversSource: null,
        chefUserId: null,
        comment: null,
        items: [],
        dinerUserIds: [],
        guestCount: 0,
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
                      setState((prev) => {
                        // No-op when re-selecting the current type, so a
                        // leftovers slot doesn't lose its picked meal.
                        if (!prev || prev.slotType === option.value)
                          return prev;
                        return {
                          ...prev,
                          slotType: option.value,
                          // Leftovers starts unpicked; any other type has no
                          // source. Dishes only survive on a Cooking slot.
                          leftoversSource: null,
                          items: option.value === 'recipe' ? prev.items : [],
                        };
                      });
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

          {showDishes && (
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
                            event.target.value === ''
                              ? null
                              : event.target.value,
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
          )}

          {state.slotType === 'leftovers' && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Which meal?</legend>
              <select
                value={leftoversSelectValue(state)}
                aria-label="Leftovers of which meal"
                onChange={(event) => {
                  setState((prev) =>
                    prev
                      ? applyLeftoversChoice(
                          prev,
                          event.target.value,
                          earlierMeals,
                        )
                      : prev,
                  );
                }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Select a meal…</option>
                {earlierMeals.length > 0 && (
                  <optgroup label="Prepared earlier in this plan">
                    {earlierMeals.map((meal) => (
                      <option
                        key={meal.recipeId}
                        value={`recipe:${String(meal.recipeId)}`}
                      >
                        {meal.recipeName}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="takeaway">Takeaway</option>
                <option value="other">Other</option>
              </select>

              {state.leftoversSource === 'plan_meal' && state.items[0] && (
                <label className="flex items-center gap-2 text-sm">
                  <span>Servings</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={state.items[0].servings}
                    aria-label={`Servings for ${state.items[0].name}`}
                    onChange={(event) => {
                      const value = event.target.value;
                      setState((prev) =>
                        prev
                          ? {
                              ...prev,
                              items: prev.items.map((it, i) =>
                                i === 0 ? { ...it, servings: value } : it,
                              ),
                            }
                          : prev,
                      );
                    }}
                    required
                    className="w-20"
                  />
                </label>
              )}

              {shortBy !== undefined && shortBy > 0 && (
                <ServingVariationWarning
                  shortBy={shortBy}
                  // Eating a base's leftovers is a base-pool deficit; eating a
                  // non-base meal's leftovers is "the meal didn't make enough".
                  variant={state.items[0]?.isBase ? 'base' : 'meal'}
                />
              )}
            </fieldset>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Who&apos;s eating{' '}
              <span className="font-normal text-muted-foreground">
                {headcount > 0
                  ? `(${String(headcount)} eating)`
                  : '(nobody yet)'}
              </span>
            </legend>
            {members.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {members.map((member) => {
                  const selected = state.dinerUserIds.includes(member.id);
                  return (
                    <label
                      key={member.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-1 rounded-md border border-input px-3 py-1 text-sm transition',
                        selected && 'border-primary bg-accent',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => {
                          setState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  dinerUserIds: selected
                                    ? prev.dinerUserIds.filter(
                                        (id) => id !== member.id,
                                      )
                                    : [...prev.dinerUserIds, member.id],
                                }
                              : prev,
                          );
                        }}
                        className="sr-only"
                      />
                      {member.name}
                    </label>
                  );
                })}
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <span>Guests</span>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={state.guestCount}
                aria-label="Number of guests"
                onChange={(event) => {
                  const value = event.target.value;
                  setState((prev) =>
                    prev ? { ...prev, guestCount: value } : prev,
                  );
                }}
                className="w-20"
              />
            </label>
          </fieldset>

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

// `guestCount` round-trips through a string input; parse it leniently (empty or
// garbage → 0) so a half-typed value never blocks a save.
function parseGuestCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : 0;
}

// Headcount = named members present + guests. Drives the "(N eating)" label and
// the new-dish servings prefill.
function headcountOf(state: EditorState): number {
  return (
    state.dinerUserIds.length + Math.max(0, parseGuestCount(state.guestCount))
  );
}

// (date, occasion) ordering — is `a` strictly before `b`? Mirrors the
// consumption walk's order so "prepared earlier" lines up with what draws the
// base pool down.
function isSlotBefore(a: PlanSlot, b: PlanSlot): boolean {
  if (a.date !== b.date) return a.date < b.date;
  return compareOccasionByName(a.occasionName, b.occasionName) < 0;
}

// The `<select>` value mirroring the editor's leftovers state: a `recipe:<id>`
// token for a plan meal, the bare source for takeaway/other, else empty.
function leftoversSelectValue(state: EditorState): string {
  if (state.leftoversSource === 'plan_meal') {
    const item = state.items[0];
    return item ? `recipe:${String(item.recipeId)}` : '';
  }
  return state.leftoversSource ?? '';
}

// Fold a leftovers-picker choice back into editor state. A plan meal becomes
// the slot's single `eat` item (servings default to the headcount, falling back
// to the original serving count); takeaway/other clear the items.
function applyLeftoversChoice(
  state: EditorState,
  value: string,
  earlierMeals: readonly PlanSlotItem[],
): EditorState {
  if (value === 'takeaway' || value === 'other') {
    return { ...state, leftoversSource: value, items: [] };
  }
  const recipeId = value.startsWith('recipe:')
    ? Number.parseInt(value.slice('recipe:'.length), 10)
    : NaN;
  const meal = earlierMeals.find((item) => item.recipeId === recipeId);
  if (!meal) return { ...state, leftoversSource: null, items: [] };
  const headcount = headcountOf(state);
  const servings = headcount > 0 ? headcount : meal.servings;
  return {
    ...state,
    leftoversSource: 'plan_meal',
    items: [
      {
        recipeId: meal.recipeId,
        name: meal.recipeName,
        imageUrl: meal.recipeImageUrl,
        isBase: meal.isBase,
        baseRecipeId: meal.baseRecipeId,
        isDeleted: meal.isDeleted,
        servings: String(servings),
        kind: 'eat',
      },
    ],
  };
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

  const isRecipe = state.slotType === 'recipe';
  const isLeftovers = state.slotType === 'leftovers';
  const leftoversSource = isLeftovers ? state.leftoversSource : null;

  // A leftovers slot can't save until a meal/takeaway/other is chosen.
  if (isLeftovers && leftoversSource === null) return null;

  // Dishes live on a "Cooking" slot, or as the single eaten dish of a
  // leftovers-of-a-plan-meal slot; every other state clears them. A chef only
  // belongs to a Cooking slot (the field is hidden elsewhere).
  const keepsItems = isRecipe || leftoversSource === 'plan_meal';
  const items = keepsItems ? state.items : [];
  if (leftoversSource === 'plan_meal' && items.length !== 1) return null;
  const chefUserId = isRecipe ? state.chefUserId : null;
  const parsed: { item: EditorItem; servings: number }[] = [];
  for (const item of items) {
    const servings = Number.parseInt(item.servings, 10);
    if (!Number.isInteger(servings) || servings <= 0) return null;
    parsed.push({ item, servings });
  }

  // An empty slot carries no attendance (the schema refine enforces this too).
  const isEmpty = state.slotType === 'empty';
  const guestCount = isEmpty
    ? 0
    : Math.max(0, parseGuestCount(state.guestCount));

  const input: UpdateSlotInput = {
    slotId: slot.id,
    slotType: state.slotType,
    leftoversSource,
    chefUserId,
    comment: commentValue,
    items: parsed.map(({ item, servings }, index) => ({
      recipeId: item.recipeId,
      servings,
      kind: item.kind,
      sortOrder: index,
    })),
    dinerUserIds: isEmpty ? [] : state.dinerUserIds,
    guestCount,
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
