import type {
  StockItem,
  StockTarget,
  StorageLocation,
} from '@loftys-larder/shared';

import { formatQuantity } from '@/lib/format-quantity.ts';

// Display rules for the Storage screen (DEC-118). The backend never merges
// Stock items: Freezer and Pantry rows combine every item of one ingredient
// or recipe here, and Fridge items are each their own row.

export interface StorageRow {
  key: string;
  target: StockTarget;
  // Oldest first for combined rows; one item for a Fridge row.
  items: StockItem[];
  // Milli-units, so totals add exactly.
  totalMilli: number;
  reservedMilli: number;
  oldestAddedOn: string;
  useBy: string | null;
}

export interface StorageGroups {
  ingredients: StorageRow[];
  dishes: StorageRow[];
}

export function toMilli(quantity: string): number {
  return Math.round(Number(quantity) * 1000);
}

export function fromMilli(milli: number): string {
  return String(milli / 1000);
}

function targetKey(target: StockTarget): string {
  return target.kind === 'ingredient'
    ? `ingredient:${String(target.ingredientId)}`
    : `recipe:${String(target.recipeId)}`;
}

function rowOf(key: string, items: StockItem[]): StorageRow {
  const sorted = [...items].sort(
    (a, b) => a.addedOn.localeCompare(b.addedOn) || a.id - b.id,
  );
  const first = sorted[0];
  if (!first) throw new Error('storage row with no items');
  return {
    key,
    target: first.target,
    items: sorted,
    totalMilli: sorted.reduce((sum, item) => sum + toMilli(item.quantity), 0),
    reservedMilli: sorted.reduce(
      (sum, item) => sum + toMilli(item.reserved),
      0,
    ),
    oldestAddedOn: first.addedOn,
    useBy: sorted.length === 1 ? first.useBy : null,
  };
}

function compareByName(a: StorageRow, b: StorageRow): number {
  return a.target.name.localeCompare(b.target.name, 'en-GB');
}

// Soonest Use-by first; a blank Use-by sorts last.
function compareByUseBy(a: StorageRow, b: StorageRow): number {
  if (a.useBy !== b.useBy) {
    if (a.useBy === null) return 1;
    if (b.useBy === null) return -1;
    return a.useBy.localeCompare(b.useBy);
  }
  return compareByName(a, b) || (a.items[0]?.id ?? 0) - (b.items[0]?.id ?? 0);
}

export function groupStorage(
  items: readonly StockItem[],
  location: StorageLocation,
): StorageGroups {
  const here = items.filter((item) => item.location === location);
  let rows: StorageRow[];
  if (location === 'fridge') {
    rows = here
      .map((item) => rowOf(`item:${String(item.id)}`, [item]))
      .sort(compareByUseBy);
  } else {
    const byTarget = new Map<string, StockItem[]>();
    for (const item of here) {
      const key = targetKey(item.target);
      const list = byTarget.get(key) ?? [];
      list.push(item);
      byTarget.set(key, list);
    }
    rows = [...byTarget.entries()]
      .map(([key, list]) => rowOf(key, list))
      .sort(compareByName);
  }
  return {
    ingredients: rows.filter((row) => row.target.kind === 'ingredient'),
    dishes: rows.filter((row) => row.target.kind === 'recipe'),
  };
}

export function formatStockAmount(milli: number, target: StockTarget): string {
  const quantity = fromMilli(milli);
  if (target.kind === 'recipe') {
    return `${quantity} ${milli === 1000 ? 'portion' : 'portions'}`;
  }
  return `${formatQuantity(quantity, target.unitName)} ${target.unitName}`;
}

// "500 g", or "2 portions, 1 reserved".
export function formatRowAmount(row: StorageRow): string {
  const total = formatStockAmount(row.totalMilli, row.target);
  if (row.reservedMilli === 0) return total;
  const reserved =
    row.target.kind === 'recipe'
      ? fromMilli(row.reservedMilli)
      : formatStockAmount(row.reservedMilli, row.target);
  return `${total}, ${reserved} reserved`;
}

function civilDayNumber(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000;
}

export function daysFrom(from: string, to: string): number {
  return civilDayNumber(to) - civilDayNumber(from);
}

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`;
}

// "added 6 weeks ago", or "frozen 6 weeks ago" in the Freezer.
export function formatStockAge(
  addedOn: string,
  today: string,
  location: StorageLocation,
): string {
  const verb = location === 'freezer' ? 'frozen' : 'added';
  const days = Math.max(0, daysFrom(addedOn, today));
  if (days === 0) return `${verb} today`;
  if (days === 1) return `${verb} yesterday`;
  if (days < 14) return `${verb} ${plural(days, 'day')}`;
  if (days < 63) return `${verb} ${plural(Math.floor(days / 7), 'week')}`;
  return `${verb} ${plural(Math.floor(days / 30), 'month')}`;
}

const WEEKDAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'short',
});
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
});

export function isPastUseBy(useBy: string | null, today: string): boolean {
  return useBy !== null && daysFrom(today, useBy) < 0;
}

// "use by Thu", "use by 3 Dec", or "past use-by".
export function formatUseBy(useBy: string | null, today: string): string {
  if (useBy === null) return 'no use-by';
  const days = daysFrom(today, useBy);
  if (days < 0) return 'past use-by';
  if (days === 0) return 'use by today';
  if (days === 1) return 'use by tomorrow';
  const instant = new Date(civilDayNumber(useBy) * 86_400_000);
  if (days <= 6) return `use by ${WEEKDAY.format(instant)}`;
  return `use by ${DAY_MONTH.format(instant)}`;
}

// The row stepper's step, in milli-units: a portion, 50 g or ml, 0.1 kg or l,
// and 1 of anything else.
export function stepMilliFor(target: StockTarget): number {
  if (target.kind === 'recipe') return 1000;
  switch (target.unitName) {
    case 'g':
    case 'ml':
      return 50_000;
    case 'kg':
    case 'l':
      return 100;
    default:
      return 1000;
  }
}

export interface StepEdit {
  id: number;
  quantity: string;
}

// One tap on a row's stepper edits one item: the newest, so a combined row
// keeps showing its oldest date. Lowering takes the newest item with some of
// it not reserved, so a plan's food is only touched once nothing else is
// left. Lowering stops at zero, which deletes the item.
export function stepEdit(row: StorageRow, direction: -1 | 1): StepEdit | null {
  const newest = row.items[row.items.length - 1];
  if (!newest) return null;
  let target = newest;
  if (direction === -1) {
    const free = [...row.items]
      .reverse()
      .find((item) => toMilli(item.quantity) > toMilli(item.reserved));
    if (free) target = free;
  }
  const step = stepMilliFor(row.target);
  const next = Math.max(0, toMilli(target.quantity) + direction * step);
  return { id: target.id, quantity: (next / 1000).toFixed(3) };
}
