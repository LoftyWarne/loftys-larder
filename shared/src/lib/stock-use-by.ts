// Default Use-by for a Fridge Stock item (DEC-118): the date it went in plus
// the ingredient's average shelf life, or plus 3 days for cooked portions. An
// ingredient with no shelf life has no default. Dates are `YYYY-MM-DD` civil
// days, so the arithmetic is on UTC midnights and never reads the clock.

export const COOKED_USE_BY_DAYS = 3;

export type UseByTarget =
  | { kind: 'ingredient'; averageShelfLifeDays: number | null }
  | { kind: 'recipe' };

export function defaultUseBy(from: string, target: UseByTarget): string | null {
  const days =
    target.kind === 'recipe' ? COOKED_USE_BY_DAYS : target.averageShelfLifeDays;
  if (days === null) return null;
  return shiftCivilDate(from, days);
}

function shiftCivilDate(iso: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`defaultUseBy: not a YYYY-MM-DD date: ${iso}`);
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days),
  );
  const y = String(shifted.getUTCFullYear()).padStart(4, '0');
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
