import type { StoredLimit } from '@loftys-larder/shared';

// Why a Freezer or Fridge count stopped short (FEAT-79): only portions still
// held and not set aside for a plan can be taken back from storage, and those
// that can't still count against what the dish has spare.
export function describeStoredLimits(
  limits: readonly StoredLimit[],
): string | null {
  if (limits.length === 0) return null;
  return limits.map(describeLimit).join(' ');
}

function describeLimit(limit: StoredLimit): string {
  const place = limit.location === 'freezer' ? 'Freezer' : 'Fridge';
  if (limit.applied > limit.requested) {
    const kept = limit.applied - limit.requested;
    return `${String(kept)} ${portions(kept)} stayed in the ${place} count: they've been eaten, moved or set aside for a plan, so they can't be taken back.`;
  }
  return `Only ${String(limit.applied)} ${portions(limit.applied)} could go in the ${place}: portions that can't be taken back from the other place still count.`;
}

function portions(count: number): string {
  return count === 1 ? 'portion' : 'portions';
}
