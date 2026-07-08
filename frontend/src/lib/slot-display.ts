import type { PlanSlot, PlanSlotItem } from '@loftys-larder/shared';

// Shared, presentation-only slot labels used by both the planner card
// (`SlotCell`) and the home page meal list. Pure string helpers — no JSX, no
// data access — so the two surfaces render dishes and leftovers identically.

// A `leftovers` slot eating a takeaway/other source shows the source name; a
// `plan_meal` source instead carries the eaten dish in `items`.
export const LEFTOVERS_SOURCE_LABEL: Record<
  Exclude<NonNullable<PlanSlot['leftoversSource']>, 'plan_meal'>,
  string
> = {
  takeaway: 'Takeaway',
  other: 'Other',
};

// Quantity label (DEC-91): what's eaten here, with a `+N` marker when the dish
// cooks more than it eats (surplus into the pool). A prepared-only batch
// (nothing eaten) reads as "prep ×N".
export function dishQtyLabel(item: PlanSlotItem): string {
  if (item.eaten <= 0) return `prep ×${String(item.prepared)}`;
  const surplus = item.prepared - item.eaten;
  return surplus > 0
    ? `×${String(item.eaten)} +${String(surplus)}`
    : `×${String(item.eaten)}`;
}

// What a `leftovers` slot is eating, as a single label: the eaten dish
// (name + qty) when one is attached, else the takeaway/other source name, else
// a dash when nothing is set yet.
export function leftoversSummary(slot: PlanSlot): string {
  const dish = slot.items[0];
  if (dish) return `${dish.recipeName} ${dishQtyLabel(dish)}`;
  if (slot.leftoversSource !== null && slot.leftoversSource !== 'plan_meal') {
    return LEFTOVERS_SOURCE_LABEL[slot.leftoversSource];
  }
  return '—';
}
