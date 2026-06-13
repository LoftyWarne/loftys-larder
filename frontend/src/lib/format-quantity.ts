// Display-side formatter for the `numeric(10,3)` quantity strings the API
// returns. The DB pads to scale (`50` → `"50.000"`); rendering those zeroes
// reads as noise. `g` quantities only need 1 decimal place; other units keep
// whatever precision the user entered (up to the DB's 3 dp cap).

const G_UNIT = 'g';

export function formatQuantity(quantity: string, unitName: string): string {
  const parsed = Number(quantity);
  if (!Number.isFinite(parsed)) return quantity;

  if (unitName === G_UNIT) {
    return stripTrailingZeros(parsed.toFixed(1));
  }
  return stripTrailingZeros(quantity);
}

function stripTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  // Drop trailing zeros, then a trailing dot if all decimals were zeros.
  return value.replace(/\.?0+$/, '');
}
