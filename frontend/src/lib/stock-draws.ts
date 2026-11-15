import type { ShoppingLineStockItem } from '@loftys-larder/shared';

// Amounts in thousandths, so sums are exact.
export function toMilli(quantity: string): number {
  return Math.round(Number(quantity) * 1000);
}

export function fromMilli(milli: number): string {
  return (milli / 1000).toFixed(3);
}

// Fills `targetMilli` from the items in the order the server listed them,
// which is the default draw order (DEC-118).
export function defaultDraws(
  items: readonly ShoppingLineStockItem[],
  targetMilli: number,
): Map<number, number> {
  const draws = new Map<number, number>();
  let remaining = targetMilli;
  for (const item of items) {
    const take = Math.min(toMilli(item.available), Math.max(remaining, 0));
    draws.set(item.stockItemId, take);
    remaining -= take;
  }
  return draws;
}

export function totalAvailableMilli(
  items: readonly ShoppingLineStockItem[],
): number {
  return items.reduce((sum, item) => sum + toMilli(item.available), 0);
}
