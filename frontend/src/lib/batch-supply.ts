import { OCCASION_ORDER, type PlanSlot } from '@loftys-larder/shared';

// Frontend mirror of `backend/src/lib/batch-supply.ts` over a plan's already
// loaded slots — the planner already holds every PlanSlot in cache, so the UI
// warning is computed without a round-trip. Returns the set of slot ids whose
// eating recipe is a batch-version (recipe.baseRecipeId != null) and no
// earlier-or-same slot in the plan cooks that base. "Earlier-or-same" matches
// the backend predicate: earlier date, or same date with equal-or-earlier
// occasion ordinal (Lunch < Dinner via OCCASION_ORDER), or the same slot id.
export function deriveBatchSupplyWarnings(
  slots: readonly PlanSlot[],
): Set<number> {
  const warnings = new Set<number>();
  for (const slot of slots) {
    if (slot.slotType !== 'recipe') continue;
    const baseRecipeId = slot.recipe?.baseRecipeId ?? null;
    if (baseRecipeId === null) continue;
    if (!hasEarlierOrSameSupply(slots, slot, baseRecipeId)) {
      warnings.add(slot.id);
    }
  }
  return warnings;
}

function hasEarlierOrSameSupply(
  slots: readonly PlanSlot[],
  target: PlanSlot,
  baseRecipeId: number,
): boolean {
  const targetOrder = OCCASION_ORDER[target.occasionName] ?? 0;
  for (const candidate of slots) {
    if (candidate.cooksBaseRecipeId !== baseRecipeId) continue;
    if (candidate.id === target.id) return true;
    if (candidate.date < target.date) return true;
    if (candidate.date === target.date) {
      const candidateOrder = OCCASION_ORDER[candidate.occasionName] ?? 0;
      if (candidateOrder <= targetOrder) return true;
    }
  }
  return false;
}
