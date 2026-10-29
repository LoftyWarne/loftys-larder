// Occasion precedence for "earlier than" comparisons on slots that share a
// date. Hardcoded for the MVP (Lunch < Dinner). If a third occasion is added
// the seed list grows; if non-linear ordering is ever needed, swap this map
// for an explicit `display_order` column on `meal_occasions`.
export const OCCASION_ORDER: Record<string, number> = {
  Lunch: 0,
  Dinner: 1,
};

export function compareOccasionByName(a: string, b: string): number {
  const aOrder = OCCASION_ORDER[a];
  const bOrder = OCCASION_ORDER[b];
  if (aOrder === undefined || bOrder === undefined) {
    return a.localeCompare(b);
  }
  return aOrder - bOrder;
}

// The consumption walk's order (DEC-88): date, then occasion. Ties are left to
// the caller.
export function compareSlotOrder(
  a: { date: string; occasionName: string },
  b: { date: string; occasionName: string },
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return compareOccasionByName(a.occasionName, b.occasionName);
}
