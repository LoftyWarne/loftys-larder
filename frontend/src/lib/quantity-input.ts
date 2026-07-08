// Quantity entry helpers for the recipe editor. Users may type a decimal
// (`1.5`) or a simple fraction (`1/2`); the API and DB store a plain
// `numeric(10,3)` decimal, so a fraction is converted before it's sent
// (DEC-19 whole-recipe quantities; no unit conversion — DEC-18). Fractions
// are normalised to a decimal on save; they aren't preserved verbatim.

const DECIMAL_RE = /^\d+(\.\d{1,3})?$/;
const FRACTION_RE = /^(\d+)\/(\d+)$/;

// Strips anything that isn't a digit or the single allowed separator. The
// first `.` or `/` typed wins; any further separator (of either kind) is
// dropped, so only one special character can ever be present.
export function sanitizeQuantityInput(raw: string): string {
  let out = '';
  let separatorUsed = false;
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') {
      out += ch;
    } else if ((ch === '.' || ch === '/') && !separatorUsed) {
      out += ch;
      separatorUsed = true;
    }
  }
  return out;
}

// Drops trailing zeros (and a bare trailing dot) from a decimal string so it
// shows no more precision than needed: `50.000` → `50`, `0.500` → `0.5`. Only
// touches strings with a decimal point, so integers (`100`) and fractions
// (`1/2`) pass through untouched.
export function trimTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}

// A well-formed decimal (≤3 dp) or a fraction with a non-zero denominator.
export function isValidQuantityEntry(value: string): boolean {
  const trimmed = value.trim();
  if (DECIMAL_RE.test(trimmed)) return true;
  const fraction = FRACTION_RE.exec(trimmed);
  return fraction !== null && Number(fraction[2]) > 0;
}

// Canonical `numeric(10,3)`-compatible decimal string for a valid entry, or
// `null` if the entry isn't valid. Fractions are evaluated and rounded to the
// column's 3-dp scale; trailing zeros are trimmed (`1/2` → `0.5`, `4/2` → `2`).
export function parseQuantityToDecimal(value: string): string | null {
  const trimmed = value.trim();
  if (DECIMAL_RE.test(trimmed)) return trimmed;

  const fraction = FRACTION_RE.exec(trimmed);
  if (!fraction) return null;
  const denominator = Number(fraction[2]);
  if (denominator <= 0) return null;

  const rounded = Math.round((Number(fraction[1]) / denominator) * 1000) / 1000;
  return trimTrailingZeros(rounded.toFixed(3));
}
