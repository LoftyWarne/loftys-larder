import {
  type PlanSlot,
  type PlanSlotItem,
  RECIPE_VIEW_SERVINGS_MAX,
} from '@loftys-larder/shared';

// Shared, presentation-only slot labels used by both the planner card
// (`SlotCell`) and the home page meal list. Pure string helpers — no JSX, no
// data access — so the two surfaces render dishes and leftovers identically.

// A `leftovers` slot eating a takeaway/other source shows the source name; a
// `plan_meal` or `storage` source instead carries the eaten dish in `items`.
type BareLeftoversSource = Exclude<
  NonNullable<PlanSlot['leftoversSource']>,
  'plan_meal' | 'storage'
>;

export const LEFTOVERS_SOURCE_LABEL: Record<BareLeftoversSource, string> = {
  takeaway: 'Takeaway',
  other: 'Other',
};

export function bareLeftoversSource(
  source: PlanSlot['leftoversSource'],
): BareLeftoversSource | null {
  return source === 'takeaway' || source === 'other' ? source : null;
}

// Food taken from storage (FEAT-81) is marked with a snowflake, except food
// held only in the Pantry. Once its day has passed the Reservations have
// settled and the location isn't known, so it keeps the snowflake.
export function takesFromStorage(item: PlanSlotItem): boolean {
  return item.fromStorage > 0;
}

export function showsSnowflake(item: PlanSlotItem): boolean {
  return (
    takesFromStorage(item) &&
    !(
      item.storageLocations.length > 0 &&
      item.storageLocations.every((location) => location === 'pantry')
    )
  );
}

// Quantity label (DEC-91): what's eaten here, with a `+N` marker when the dish
// cooks more than it eats or stores (surplus into the pool). A prepared-only
// batch (nothing eaten) reads as "prep ×N". Portions stored from the dish
// (FEAT-79) follow, e.g. "×2 +4 · 2 frozen".
export function dishQtyLabel(item: PlanSlotItem): string {
  return [eatenLabel(item), ...storedLabels(item)].join(' · ');
}

function eatenLabel(item: PlanSlotItem): string {
  if (item.eaten <= 0) return `prep ×${String(item.prepared)}`;
  const surplus = item.prepared - item.eaten - item.frozen - item.chilled;
  return surplus > 0
    ? `×${String(item.eaten)} +${String(surplus)}`
    : `×${String(item.eaten)}`;
}

function storedLabels(item: PlanSlotItem): string[] {
  const labels: string[] = [];
  if (item.fromStorage > 0 && item.prepared > 0) {
    labels.push('base from storage');
  }
  if (item.frozen > 0) labels.push(`${String(item.frozen)} frozen`);
  if (item.chilled > 0) labels.push(`${String(item.chilled)} in fridge`);
  return labels;
}

// What a `leftovers` slot is eating, as a single label: the eaten dish
// (name + qty) when one is attached, else the takeaway/other source name, else
// a dash when nothing is set yet.
export function leftoversSummary(slot: PlanSlot): string {
  const dish = slot.items[0];
  if (dish) {
    const from = slot.leftoversSource === 'storage' ? ' from storage' : '';
    return `${dish.recipeName} ${dishQtyLabel(dish)}${from}`;
  }
  const bare = bareLeftoversSource(slot.leftoversSource);
  return bare ? LEFTOVERS_SOURCE_LABEL[bare] : '—';
}

// The portions a dish's recipe opens at (DEC-98), on its recipe page or in
// cook mode: a dish being cooked opens scaled to the portions prepared; one
// only eaten here (leftovers, `prepared = 0`) opens at the recipe's own
// servings.
export function dishServingsSearch(item: Pick<PlanSlotItem, 'prepared'>): {
  servings?: number;
} {
  return item.prepared > 0 && item.prepared <= RECIPE_VIEW_SERVINGS_MAX
    ? { servings: item.prepared }
    : {};
}
