import { formatQuantity } from '@/lib/format-quantity.ts';

// Display-only amounts for a recipe viewed at another number of portions
// (DEC-98). At the recipe's own servings (factor 1) an amount renders exactly
// as `formatQuantity` always has. Scaled amounts are rounded per unit so they
// read like a recipe rather than a calculator. Units are never converted
// (DEC-18).

const WHOLE_ABOVE_TEN = new Set(['g', 'ml']);
const QUARTERS = new Set(['tsp', 'tbsp', 'cup', 'piece']);
const WHOLE = new Set(['pinch']);

const QUARTER_GLYPHS = ['', '¼', '½', '¾'] as const;

export function formatScaledQuantity(
  quantity: number,
  unitName: string,
  factor: number,
): string {
  if (factor === 1) return formatQuantity(quantity.toFixed(3), unitName);

  const value = quantity * factor;
  if (QUARTERS.has(unitName)) return toQuarters(value);
  if (WHOLE.has(unitName)) return String(Math.max(1, Math.round(value)));

  // Everything else, `kg` and `l` included, keeps up to 2 dp.
  let rounded = value.toFixed(2);
  if (WHOLE_ABOVE_TEN.has(unitName)) {
    rounded = value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  }
  // A small amount must never round away to nothing.
  if (Number(rounded) === 0 && value > 0) rounded = value.toPrecision(1);
  return stripTrailingZeros(rounded);
}

// Nearest quarter, as a whole number plus a fraction glyph ("1½"), and never
// less than a quarter.
function toQuarters(value: number): string {
  const quarters = Math.max(1, Math.round(value * 4));
  const whole = Math.floor(quarters / 4);
  const glyph = QUARTER_GLYPHS[quarters % 4] ?? '';
  return `${whole > 0 ? String(whole) : ''}${glyph}`;
}

function stripTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}
