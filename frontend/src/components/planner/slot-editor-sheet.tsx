import type {
  HouseholdMember,
  LeftoversSource,
  PlanSlot,
  PlanSlotItem,
  RecipeListItem,
  SlotType,
  StockItem,
  StorageLocation,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import {
  compareOccasionByName,
  SLOT_COMMENT_MAX_LENGTH,
} from '@loftys-larder/shared';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';

import { RecipeTypeBadge } from '@/components/planner/recipe-type-badge.tsx';
import { ServingVariationWarning } from '@/components/planner/serving-variation-warning.tsx';
import {
  SearchableCombobox,
  type SearchableComboboxHandle,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { TagFilter } from '@/components/tag-filter.tsx';
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
import { formatLongDayLabel, todayInLondon } from '@/lib/date-utils.ts';
import {
  deriveBaseBalances,
  itemConsumedBase,
} from '@/lib/serving-variation-supply.ts';
import {
  dishPickerEntries,
  heldBase,
  type StoragePickerEntry,
} from '@/lib/storage-picker.ts';
import { trpc } from '@/lib/trpc.ts';
import { cn } from '@/lib/utils.ts';

const SLOT_TYPE_OPTIONS: { value: SlotType; label: string }[] = [
  { value: 'recipe', label: 'Cooking' },
  { value: 'eat_out', label: 'Eat out' },
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'leftovers', label: 'Leftovers' },
  { value: 'empty', label: 'Empty' },
];

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

// One dish being edited (DEC-91). `prepared` = portions cooked, `eaten` =
// portions consumed here, `frozen` = portions sent to the Freezer (FEAT-79);
// strings so the inputs round-trip what the user types. Role (produce /
// consume) is derived, not stored. `chilled` (kept in the Fridge) is set from
// the slot card's "Store…" only, so it's read-only here.
// `fromStorage` (FEAT-81): the dish is eaten from storage (on a Leftovers
// from Storage slot), or a Variation cooked from its base held in storage
// ("Use frozen base"). `savedReserved` and `storageLocations` are what the
// saved dish holds now; `stockItemIds` is the picker entry chosen here.
interface EditorItem {
  recipeId: number;
  name: string;
  imageUrl: string | null;
  isBase: boolean;
  baseRecipeId: number | null;
  isDeleted: boolean;
  prepared: string;
  eaten: string;
  frozen: string;
  chilled: number;
  fromStorage: boolean;
  savedReserved: number;
  storageLocations: StorageLocation[];
  stockItemIds?: number[];
}

interface EditorState {
  slotType: SlotType;
  // The storage picker entry chosen since opening, or null for the saved one.
  stockChoice: string | null;
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

// Default quantities for a freshly-added dish (DEC-91). A base is a batch cooked
// to supply serving variations and leftovers, so it defaults to `prepared` =
// its batch size (`baseServings`) with nothing eaten directly — listing it in a
// slot's dishes then covers a variation eaten there, clearing the shortfall.
// Eating the plain base is the exception the user opts into via the Eat field. A
// standalone / variation cooks what it eats: `eaten` follows the headcount,
// falling back to the recipe's own base servings. `pureCook` (the suggested-base
// shortcut) forces `eaten` to 0 for any recipe.
function defaultQuantities(
  recipe: AddableRecipe,
  headcount: number,
  pureCook: boolean,
): { prepared: number; eaten: number } {
  if (recipe.isBase) {
    return { prepared: recipe.baseServings, eaten: 0 };
  }
  const eaten = pureCook ? 0 : headcount > 0 ? headcount : recipe.baseServings;
  return { prepared: eaten, eaten };
}

function toEditorItem(
  recipe: AddableRecipe,
  prepared: number,
  eaten: number,
): EditorItem {
  return {
    recipeId: recipe.id,
    name: recipe.name,
    imageUrl: recipe.imageUrl,
    isBase: recipe.isBase,
    baseRecipeId: recipe.baseRecipeId,
    isDeleted: recipe.isDeleted,
    prepared: String(prepared),
    eaten: String(eaten),
    frozen: '0',
    chilled: 0,
    fromStorage: false,
    savedReserved: 0,
    storageLocations: [],
  };
}

// Lenient parse for a quantity input: empty or garbage → 0, negatives clamped.
function parseQuantity(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

// A Cooking-slot dish can't be eaten or stored in greater quantity than it's
// cooked here — the inputs stay coupled (DEC-91, FEAT-79). Set the dish's
// prepared value, pulling eaten and then frozen down to fit. Fridge portions
// can't be changed here, so they always keep their room.
function withPrepared(item: EditorItem, value: string): EditorItem {
  const prepared = Number.parseInt(value, 10);
  if (!Number.isInteger(prepared)) return { ...item, prepared: value };
  const room = Math.max(prepared - item.chilled, 0);
  const eatenNow = parseQuantity(item.eaten);
  const eaten = eatenNow > room ? String(room) : item.eaten;
  const frozenRoom = room - Math.min(eatenNow, room);
  const frozen =
    parseQuantity(item.frozen) > frozenRoom ? String(frozenRoom) : item.frozen;
  return { ...item, prepared: value, eaten, frozen };
}

// Set the dish's eaten value, capped at what's prepared and not stored.
function withEaten(item: EditorItem, value: string): EditorItem {
  const eaten = Number.parseInt(value, 10);
  const cap = Math.max(
    parseQuantity(item.prepared) - parseQuantity(item.frozen) - item.chilled,
    0,
  );
  const capped = Number.isInteger(eaten) && eaten > cap ? String(cap) : value;
  return { ...item, eaten: capped };
}

// Set the dish's frozen value, capped at what's prepared and not eaten or kept
// in the Fridge.
function withFrozen(item: EditorItem, value: string): EditorItem {
  const frozen = Number.parseInt(value, 10);
  const cap = Math.max(
    parseQuantity(item.prepared) - parseQuantity(item.eaten) - item.chilled,
    0,
  );
  const capped = Number.isInteger(frozen) && frozen > cap ? String(cap) : value;
  return { ...item, frozen: capped };
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
  const [tagIds, setTagIds] = useState<number[]>([]);
  const comboboxRef = useRef<SearchableComboboxHandle>(null);

  useEffect(() => {
    if (!slot) {
      setState(null);
      return;
    }
    setIsAddingDish(false);
    setTagIds([]);
    // A batch-prep-only occasion is saved as an `empty`-status slot still
    // carrying its prepared-only items (DEC-91: `recipe` iff ≥1 eaten item).
    // The dish list only renders under "Cooking", so open such a slot in
    // Cooking to surface those dishes for editing.
    const initialSlotType =
      slot.slotType === 'empty' && slot.items.length > 0
        ? 'recipe'
        : slot.slotType;
    setState({
      slotType: initialSlotType,
      stockChoice: null,
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
        prepared: String(item.prepared),
        eaten: String(item.eaten),
        frozen: String(item.frozen),
        chilled: item.chilled,
        fromStorage: item.fromStorage > 0,
        savedReserved: item.reserved,
        storageLocations: item.storageLocations,
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

  // What's held (FEAT-81), for the leftovers picker and "Use frozen base".
  const storageQuery = trpc.storage.list.useQuery(undefined, {
    enabled: open,
  });
  const stock: readonly StockItem[] = storageQuery.data?.items ?? NO_STOCK;
  const today = storageQuery.data?.today ?? todayInLondon();
  const savedStorageRecipeId =
    slot?.leftoversSource === 'storage'
      ? (slot.items[0]?.recipeId ?? null)
      : null;
  // A slot whose day has passed has had its food settled, so storage can't
  // be newly taken there: the picker offers only what it saved, and "Use
  // frozen base" is hidden.
  const isPastSlot = slot !== null && slot.date < today;
  const storageEntries = useMemo(
    () =>
      isPastSlot ? [] : dishPickerEntries(stock, today, savedStorageRecipeId),
    [isPastSlot, stock, today, savedStorageRecipeId],
  );

  // Suggest cooking the base behind an eaten dish when nothing in this slot is
  // preparing it (carried over from the old base modal). Computed from the live
  // editor items so it tracks what the user is adding.
  const suggestedBaseRecipeId =
    (state?.items ?? [])
      .filter((it) => parseQuantity(it.eaten) > 0)
      .map(itemConsumedBase)
      .find(
        (id) =>
          id !== null &&
          !(state?.items ?? []).some(
            (it) => it.recipeId === id && parseQuantity(it.prepared) > 0,
          ),
      ) ?? null;
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
  // A meal already eaten up by earlier slots has no leftovers to offer, so it's
  // dropped — unless it's the meal this slot was saved eating, which stays so
  // the picker still shows it (with its shortfall warning). `remainingBefore`
  // also caps the servings a picked meal defaults to.
  const { earlierMeals, remainingBefore } = useMemo(() => {
    if (!slot) {
      return { earlierMeals: [], remainingBefore: new Map<number, number>() };
    }
    const earlierSlots = slots.filter((candidate) =>
      isSlotBefore(candidate, slot),
    );
    const remainingBefore = deriveBaseBalances(earlierSlots).remainingByBase;
    const savedRecipeId =
      slot.leftoversSource === 'plan_meal' ? slot.items[0]?.recipeId : null;
    const byRecipe = new Map<number, PlanSlotItem>();
    for (const candidate of earlierSlots) {
      if (candidate.slotType !== 'recipe') continue;
      for (const item of candidate.items) {
        if (byRecipe.has(item.recipeId)) continue;
        const hasLeftovers = (remainingBefore.get(item.recipeId) ?? 0) > 0;
        if (hasLeftovers || item.recipeId === savedRecipeId) {
          byRecipe.set(item.recipeId, item);
        }
      }
    }
    return { earlierMeals: [...byRecipe.values()], remainingBefore };
  }, [slots, slot]);

  const liveBalances = useMemo(() => {
    if (!slot || !state) return null;
    // A leftovers-of-a-plan-meal slot draws the base pool down too, so its one
    // eat item counts here exactly like a Cooking slot's dishes.
    const itemsCount =
      state.slotType === 'recipe' ||
      (state.slotType === 'leftovers' &&
        (state.leftoversSource === 'plan_meal' ||
          state.leftoversSource === 'storage'));
    const liveItems: PlanSlotItem[] = itemsCount
      ? state.items.map((item, index) =>
          toPlanSlotItem(item, index, state, stock, today),
        )
      : [];
    return deriveBaseBalances(
      [
        ...slots.filter((s) => s.id !== slot.id),
        {
          ...slot,
          slotType: state.slotType,
          leftoversSource: state.leftoversSource,
          items: liveItems,
        },
      ],
      today,
    );
  }, [slots, slot, state, stock, today]);

  if (!slot || !state) return null;

  const shortBy = liveBalances?.shortfallBySlot.get(slot.id);
  // Per-dish shortfall — the live items carry synthetic ids (index + 1), so the
  // Dishes table can look each row up by its index.
  const shortfallByItem = liveBalances?.shortfallByItem;
  const remainingByRecipe = liveBalances?.remainingByBase;
  const headcount = headcountOf(state);

  function addRecipe(recipe: AddableRecipe, pureCook = false): void {
    setState((prev) => {
      if (!prev) return prev;
      // Guard against duplicates — the same recipe can't appear twice in one
      // slot.
      if (prev.items.some((it) => it.recipeId === recipe.id)) return prev;
      const { prepared, eaten } = defaultQuantities(
        recipe,
        headcountOf(prev),
        pureCook,
      );
      return {
        ...prev,
        items: [...prev.items, toEditorItem(recipe, prepared, eaten)],
      };
    });
  }

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!slot || !state) return;
    const built = buildInputForSave(slot, state, stock, today);
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
          'left-0 right-0 top-auto bottom-0 max-w-none translate-x-0 translate-y-0 rounded-t-lg rounded-b-none sm:bottom-auto sm:left-[50%] sm:right-auto sm:top-[50%] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg lg:max-w-2xl',
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
                <div className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_3.5rem_2rem] items-center gap-x-2 rounded-md border border-border">
                  <div className="col-span-full grid grid-cols-subgrid items-center border-b border-border px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      Dish
                    </span>
                    <span className="text-xs font-medium text-muted-foreground">
                      Prepare
                    </span>
                    <span className="text-xs font-medium text-muted-foreground">
                      Eat
                    </span>
                    <span className="text-xs font-medium text-muted-foreground">
                      Freeze
                    </span>
                    <span aria-hidden="true" />
                  </div>
                  {state.items.map((item, index) => {
                    // Surface "left in plan" once a dish cooks more than it eats
                    // here (it feeds the pool later meals draw on).
                    const remaining =
                      parseQuantity(item.prepared) > parseQuantity(item.eaten)
                        ? remainingByRecipe?.get(item.recipeId)
                        : undefined;
                    // Live items are keyed by index + 1 in `liveBalances`.
                    const itemShort = shortfallByItem?.get(index + 1);
                    return (
                      <Fragment
                        key={`${String(item.recipeId)}:${String(index)}`}
                      >
                        <div
                          className="col-span-full grid grid-cols-subgrid items-center px-3 py-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border"
                          data-testid="dish-item-row"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className="min-w-0 truncate text-sm"
                              title={item.name}
                            >
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
                              {item.chilled > 0 && (
                                <span
                                  className="ml-1 text-xs text-muted-foreground"
                                  data-testid="dish-chilled"
                                >
                                  ({String(item.chilled)} in fridge)
                                </span>
                              )}
                            </span>
                            <RecipeTypeBadge
                              recipe={item}
                              className="ml-auto"
                            />
                          </div>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={item.chilled}
                            value={item.prepared}
                            aria-label={`Prepared for ${item.name}`}
                            onChange={(event) => {
                              const value = event.target.value;
                              setState((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      items: prev.items.map((it, i) =>
                                        i === index
                                          ? withPrepared(it, value)
                                          : it,
                                      ),
                                    }
                                  : prev,
                              );
                            }}
                            className="w-full"
                          />
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={Math.max(
                              parseQuantity(item.prepared) -
                                parseQuantity(item.frozen) -
                                item.chilled,
                              0,
                            )}
                            value={item.eaten}
                            aria-label={`Eaten for ${item.name}`}
                            onChange={(event) => {
                              const value = event.target.value;
                              setState((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      items: prev.items.map((it, i) =>
                                        i === index ? withEaten(it, value) : it,
                                      ),
                                    }
                                  : prev,
                              );
                            }}
                            className="w-full"
                          />
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={Math.max(
                              parseQuantity(item.prepared) -
                                parseQuantity(item.eaten) -
                                item.chilled,
                              0,
                            )}
                            value={item.frozen}
                            aria-label={`Frozen for ${item.name}`}
                            onChange={(event) => {
                              const value = event.target.value;
                              setState((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      items: prev.items.map((it, i) =>
                                        i === index
                                          ? withFrozen(it, value)
                                          : it,
                                      ),
                                    }
                                  : prev,
                              );
                            }}
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
                        <UseHeldBaseToggle
                          hidden={isPastSlot}
                          item={item}
                          stock={stock}
                          today={today}
                          onChange={(checked) => {
                            setState((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    items: prev.items.map((it, i) =>
                                      i === index
                                        ? { ...it, fromStorage: checked }
                                        : it,
                                    ),
                                  }
                                : prev,
                            );
                          }}
                        />
                        {itemShort !== undefined && itemShort > 0 && (
                          <div className="col-span-full px-3 pb-2">
                            <ServingVariationWarning
                              shortBy={itemShort}
                              // A base or a variation-of-a-base is short on the
                              // base pool; a standalone is short on itself.
                              variant={
                                item.fromStorage
                                  ? 'storage'
                                  : item.isBase || item.baseRecipeId !== null
                                    ? 'base'
                                    : 'meal'
                              }
                            />
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              )}
              {showAdder && (
                <TagFilter selectedIds={tagIds} onChange={setTagIds} />
              )}
              {showAdder ? (
                <SearchableCombobox<RecipeOption>
                  ref={comboboxRef}
                  value={null}
                  onChange={(option) => {
                    if (!option) return;
                    addRecipe(option.recipe);
                    // Collapse back to the "Add another dish" button, which
                    // also clears the search text by unmounting the input.
                    setIsAddingDish(false);
                  }}
                  searchQuery={async (query) => {
                    const result = await utils.recipes.list.fetch({
                      search: query || undefined,
                      tagIds: tagIds.length > 0 ? tagIds : undefined,
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
                    addRecipe(suggestionQuery.data, true);
                  }}
                  className="self-start rounded-md border border-dashed border-primary px-2 py-1 text-xs text-primary hover:bg-accent"
                >
                  Suggested: {suggestionQuery.data.name} — cook this?
                </button>
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
                          remainingBefore,
                          storageEntries,
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
                {(storageEntries.length > 0 ||
                  slot.leftoversSource === 'storage') && (
                  <optgroup label="From storage">
                    {slot.leftoversSource === 'storage' && slot.items[0] && (
                      <option value={SAVED_STORAGE_TOKEN}>
                        {savedStorageLabel(slot.items[0])}
                      </option>
                    )}
                    {storageEntries.map((entry) => (
                      <option key={entry.token} value={entry.token}>
                        {entry.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="takeaway">Takeaway</option>
                <option value="other">Other</option>
              </select>

              {(state.leftoversSource === 'plan_meal' ||
                state.leftoversSource === 'storage') &&
                state.items[0] && (
                  <label className="flex items-center gap-2 text-sm">
                    <span>Servings</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={state.items[0].eaten}
                      aria-label={`Servings for ${state.items[0].name}`}
                      onChange={(event) => {
                        const value = event.target.value;
                        setState((prev) =>
                          prev
                            ? {
                                ...prev,
                                items: prev.items.map((it, i) =>
                                  i === 0 ? { ...it, eaten: value } : it,
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
                  // From storage, it's not enough held.
                  variant={
                    state.leftoversSource === 'storage'
                      ? 'storage'
                      : state.items[0]?.isBase
                        ? 'base'
                        : 'meal'
                  }
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
  if (state.leftoversSource === 'storage') {
    return state.stockChoice ?? SAVED_STORAGE_TOKEN;
  }
  return state.leftoversSource ?? '';
}

const NO_STOCK: readonly StockItem[] = [];

// The picker's entry for the dish a saved Leftovers from Storage slot eats,
// whichever Stock items now hold it.
const SAVED_STORAGE_TOKEN = 'stock:saved';

function savedStorageLabel(item: PlanSlotItem): string {
  const pantryOnly =
    item.storageLocations.length > 0 &&
    item.storageLocations.every((location) => location === 'pantry');
  const deleted = item.isDeleted ? ' (deleted)' : '';
  return `${pantryOnly ? '' : '❄ '}${item.recipeName}${deleted} — as planned`;
}

// "Use frozen base" on a dish row (FEAT-81): a Variation being cooked whose
// base is held in the Freezer or Fridge, or that already uses it. Never
// automatic: the cook ticks it.
function UseHeldBaseToggle({
  hidden,
  item,
  stock,
  today,
  onChange,
}: {
  hidden: boolean;
  item: EditorItem;
  stock: readonly StockItem[];
  today: string;
  onChange: (checked: boolean) => void;
}): React.ReactElement | null {
  if (hidden) return null;
  if (item.baseRecipeId === null || parseQuantity(item.prepared) <= 0) {
    return null;
  }
  const held = heldBase(stock, item.baseRecipeId, today);
  if (!item.fromStorage && held.free <= 0) return null;
  const label =
    held.allFrozen || held.free <= 0
      ? 'Use frozen base'
      : 'Use base from storage';
  const portions = held.free + (item.fromStorage ? item.savedReserved : 0);
  return (
    <label className="col-span-full flex items-center gap-2 px-3 pb-2 text-xs">
      <input
        type="checkbox"
        checked={item.fromStorage}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>
        ❄ {label}{' '}
        <span className="text-muted-foreground">({String(portions)} held)</span>
      </span>
    </label>
  );
}

// The portions a dish takes from storage, by the rules the server checks: all
// it eats on a Leftovers from Storage slot, or all a Variation prepares.
function storagePortions(item: EditorItem, state: EditorState): number {
  if (!item.fromStorage) return 0;
  if (state.slotType === 'leftovers' && state.leftoversSource === 'storage') {
    return parseQuantity(item.eaten);
  }
  if (item.baseRecipeId === null) return 0;
  return parseQuantity(item.prepared);
}

// How much the server would reserve for the dish, for the live warnings
// before saving: what it holds now plus what's free where it may draw from.
function estimateReserved(
  item: EditorItem,
  portions: number,
  state: EditorState,
  stock: readonly StockItem[],
  today: string,
): number {
  if (portions === 0) return 0;
  const eatsStoredDish =
    state.slotType === 'leftovers' && state.leftoversSource === 'storage';
  let free: number;
  if (!eatsStoredDish && item.baseRecipeId !== null) {
    free = heldBase(stock, item.baseRecipeId, today).free;
  } else {
    const chosen = item.stockItemIds ? new Set(item.stockItemIds) : null;
    free =
      stock
        .filter(
          (entry) =>
            entry.target.kind === 'recipe' &&
            entry.target.recipeId === item.recipeId &&
            (chosen === null || chosen.has(entry.id)),
        )
        .reduce(
          (sum, entry) =>
            sum +
            Math.max(
              0,
              Math.round(
                (Number(entry.quantity) - Number(entry.reserved)) * 1000,
              ),
            ),
          0,
        ) / 1000;
  }
  return Math.min(portions, item.savedReserved + free);
}

function toPlanSlotItem(
  item: EditorItem,
  index: number,
  state: EditorState,
  stock: readonly StockItem[],
  today: string,
): PlanSlotItem {
  const fromStorage = storagePortions(item, state);
  return {
    id: index + 1,
    recipeId: item.recipeId,
    recipeName: item.name,
    recipeImageUrl: item.imageUrl,
    isBase: item.isBase,
    baseRecipeId: item.baseRecipeId,
    isDeleted: item.isDeleted,
    prepared: parseQuantity(item.prepared),
    eaten: parseQuantity(item.eaten),
    frozen: parseQuantity(item.frozen),
    chilled: item.chilled,
    fromStorage,
    reserved: estimateReserved(item, fromStorage, state, stock, today),
    storageLocations: item.storageLocations,
    sortOrder: index,
  };
}

// Fold a leftovers-picker choice back into editor state. A plan meal becomes
// the slot's single pure-consume item (DEC-91: `prepared=0`, since the food was
// cooked earlier; `eaten` defaults to the headcount, falling back to the
// original serving count, capped at the portions left); takeaway/other clear
// the items.
function applyLeftoversChoice(
  state: EditorState,
  value: string,
  earlierMeals: readonly PlanSlotItem[],
  remainingBefore: ReadonlyMap<number, number>,
  storageEntries: readonly StoragePickerEntry[],
): EditorState {
  if (value === 'takeaway' || value === 'other') {
    return { ...state, stockChoice: null, leftoversSource: value, items: [] };
  }
  if (value === SAVED_STORAGE_TOKEN) {
    // Back to the dish as saved: keep the current item, drawing anywhere.
    const item = state.items[0];
    return {
      ...state,
      stockChoice: null,
      items: item ? [{ ...item, stockItemIds: undefined }] : [],
    };
  }
  const entry = storageEntries.find((candidate) => candidate.token === value);
  if (entry) return applyStorageChoice(state, entry);
  const recipeId = value.startsWith('recipe:')
    ? Number.parseInt(value.slice('recipe:'.length), 10)
    : NaN;
  const meal = earlierMeals.find((item) => item.recipeId === recipeId);
  if (!meal) return { ...state, leftoversSource: null, items: [] };
  const headcount = headcountOf(state);
  const wanted = headcount > 0 ? headcount : meal.eaten || meal.prepared;
  // A saved meal can be offered with nothing left; leave its default uncapped
  // rather than zero so the slot stays saveable and the shortfall shows.
  const remaining = remainingBefore.get(meal.recipeId) ?? 0;
  const eaten = remaining > 0 ? Math.min(wanted, remaining) : wanted;
  return {
    ...state,
    stockChoice: null,
    leftoversSource: 'plan_meal',
    items: [
      {
        recipeId: meal.recipeId,
        name: meal.recipeName,
        imageUrl: meal.recipeImageUrl,
        isBase: meal.isBase,
        baseRecipeId: meal.baseRecipeId,
        isDeleted: meal.isDeleted,
        prepared: '0',
        eaten: String(eaten),
        frozen: '0',
        chilled: 0,
        fromStorage: false,
        savedReserved: 0,
        storageLocations: [],
      },
    ],
  };
}

// A dish picked from storage becomes the slot's one eaten item, eaten by the
// headcount (or what's free, when nobody's set as eating yet). The slot holds
// what it already reserved of the same dish.
function applyStorageChoice(
  state: EditorState,
  entry: StoragePickerEntry,
): EditorState {
  const current = state.items[0];
  const same =
    state.leftoversSource === 'storage' && current?.recipeId === entry.recipeId;
  const headcount = headcountOf(state);
  const eaten = headcount > 0 ? headcount : Math.max(1, Math.floor(entry.free));
  return {
    ...state,
    stockChoice: entry.token,
    leftoversSource: 'storage',
    items: [
      {
        recipeId: entry.recipeId,
        name: entry.name,
        imageUrl: null,
        isBase: entry.isBase,
        baseRecipeId: null,
        isDeleted: entry.isDeleted,
        prepared: '0',
        eaten: String(eaten),
        frozen: '0',
        chilled: 0,
        fromStorage: true,
        savedReserved: same ? current.savedReserved : 0,
        storageLocations: [entry.location],
        stockItemIds: entry.stockItemIds,
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
  stock: readonly StockItem[],
  today: string,
): BuiltSave | null {
  const trimmedComment = state.comment.trim();
  const commentValue = trimmedComment === '' ? null : trimmedComment;

  const isRecipe = state.slotType === 'recipe';
  const isLeftovers = state.slotType === 'leftovers';
  const leftoversSource = isLeftovers ? state.leftoversSource : null;

  // A leftovers slot can't save until a meal/takeaway/other is chosen.
  if (isLeftovers && leftoversSource === null) return null;

  // Dishes live on a "Cooking" slot, or as the single eaten dish of a
  // leftovers-of-a-plan-meal slot; every other state clears them.
  const keepsDish =
    leftoversSource === 'plan_meal' || leftoversSource === 'storage';
  const items = isRecipe || keepsDish ? state.items : [];
  if (keepsDish && items.length !== 1) return null;

  // DEC-91: `slot_type='recipe'` iff ≥1 item is eaten here; prepared-only
  // cook-ahead rows are allowed on any slot type. A "Cooking" slot the user
  // filled with only batch-prep dishes (nothing eaten) saves as an
  // `empty`-status slot still carrying those items — the pool reads items
  // regardless of slot type.
  const hasEatenItem = items.some((item) => parseQuantity(item.eaten) > 0);
  const slotType = isRecipe && !hasEatenItem ? 'empty' : state.slotType;

  // A chef only belongs to a Cooking slot (the field is hidden elsewhere).
  const chefUserId = slotType === 'recipe' ? state.chefUserId : null;
  const parsed: {
    item: EditorItem;
    prepared: number;
    eaten: number;
    frozen: number;
  }[] = [];
  for (const item of items) {
    const prepared = parseQuantity(item.prepared);
    const eaten = parseQuantity(item.eaten);
    const frozen = parseQuantity(item.frozen);
    // Every dish must do at least one of cook / eat (matches the DB CHECK).
    if (prepared + eaten <= 0) return null;
    parsed.push({ item, prepared, eaten, frozen });
  }

  // Attendance is independent of the slot type — who's eating persists even on
  // an empty slot. Only the explicit Clear action wipes it.
  const guestCount = Math.max(0, parseGuestCount(state.guestCount));

  const input: UpdateSlotInput = {
    slotId: slot.id,
    slotType,
    leftoversSource,
    chefUserId,
    comment: commentValue,
    items: parsed.map(({ item, prepared, eaten, frozen }, index) => {
      const fromStorage = storagePortions(item, state);
      return {
        recipeId: item.recipeId,
        prepared,
        eaten,
        frozen,
        ...(fromStorage > 0 && { fromStorage }),
        ...(fromStorage > 0 &&
          item.stockItemIds && { stockItemIds: item.stockItemIds }),
        sortOrder: index,
      };
    }),
    dinerUserIds: state.dinerUserIds,
    guestCount,
  };

  const optimisticItems: PlanSlotItem[] = parsed.map(({ item }, index) =>
    toPlanSlotItem(item, index, state, stock, today),
  );

  return { input, optimisticItems };
}
