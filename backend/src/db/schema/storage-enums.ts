import { pgEnum } from 'drizzle-orm/pg-core';

// Shared by Stock items and Staples (DEC-118). A file of its own so
// `ingredients.ts` and `storage.ts` don't import each other.
export const storageLocation = pgEnum('storage_location', [
  'freezer',
  'fridge',
  'pantry',
]);

export const stapleState = pgEnum('staple_state', [
  'in_stock',
  'running_low',
  'out',
]);
