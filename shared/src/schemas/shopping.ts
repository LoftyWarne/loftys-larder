import { z } from 'zod';

import {
  stapleStateSchema,
  stockQuantitySchema,
  storageLocationSchema,
} from './storage.ts';

// Shopping list DTOs. Read-side aggregation for a plan (DEC-19 scaling,
// DEC-24 cooks-base contributions, DEC-23 serving-variation no-double-count).
// Numeric quantities round-trip as decimal strings to avoid float drift;
// the same precedent as `recipeIngredientLineSchema.quantity`.
//
// Output is nested by category — `categories[].lines[]` — so the
// shopping-list view in FEAT-39 can render section headers directly,
// and so FEAT-37's shelf-life decoration attaches to a `line` shape
// that the UI already understands.

const planIdSchema = z.number().int().positive();
const slotIdSchema = z.number().int().positive();
const recipeIdSchema = z.number().int().positive();
const ingredientIdSchema = z.number().int().positive();
const unitIdSchema = z.number().int().positive();
const categoryIdSchema = z.number().int().positive();

const civilDateSchema = z.iso.date();
// numeric(10,3) on the wire as a string.
const quantitySchema = z.string();

export const shoppingListContributingSlotSchema = z.object({
  slotId: slotIdSchema,
  recipeId: recipeIdSchema,
  recipeName: z.string(),
  date: civilDateSchema,
  scaledQuantity: quantitySchema,
  // True when every line of this ingredient in the recipe is optional.
  isOptional: z.boolean(),
});
export type ShoppingListContributingSlot = z.infer<
  typeof shoppingListContributingSlotSchema
>;

// Shelf-life decoration on a line. Present only when the ingredient has a
// shelf life set AND at least one contributing slot lands strictly past the
// `(planStart + shelfLifeDays)` boundary (DEC-37). `daysOverflow` is the
// whole-day gap from the boundary to `latestNeededDate` (boundary +1 → 1).
// Absent — not `null` — when the ingredient fits within shelf life.
export const shelfLifeWarningSchema = z.object({
  latestNeededDate: civilDateSchema,
  daysOverflow: z.number().int().positive(),
});
export type ShelfLifeWarning = z.infer<typeof shelfLifeWarningSchema>;

// A Stock item the line could draw on (DEC-118), in the default draw order:
// Fridge items by soonest Use-by, then the oldest Freezer and Pantry items.
// `available` is what this line could reserve from it: its quantity less
// every other Reservation. `reservedByLine` is this line's own share.
export const shoppingLineStockItemSchema = z.object({
  stockItemId: z.number().int().positive(),
  location: storageLocationSchema,
  available: quantitySchema,
  reservedByLine: quantitySchema,
  addedOn: civilDateSchema,
  useBy: civilDateSchema.nullable(),
});
export type ShoppingLineStockItem = z.infer<typeof shoppingLineStockItemSchema>;

export const shoppingListLineSchema = z.object({
  ingredient: z.object({
    id: ingredientIdSchema,
    name: z.string(),
  }),
  unit: z.object({
    id: unitIdSchema,
    name: z.string(),
  }),
  totalQuantity: quantitySchema,
  contributingSlots: z.array(shoppingListContributingSlotSchema),
  // Persistent check-state for the line (DEC-30 lazy-create, DEC-31
  // quantity-bound reset). Always present on the read DTO; the procedure
  // performs any reset before returning, so the value reflects post-reset
  // truth.
  isChecked: z.boolean(),
  // True only when every contribution is optional — one required use makes
  // the whole line required.
  isOptional: z.boolean(),
  // Absent when the line is fully covered from storage: the warning is about
  // food still to buy (DEC-37).
  shelfLifeWarning: shelfLifeWarningSchema.optional(),
  // What this line has set aside from storage, and what's left to buy:
  // `totalQuantity - reserved`. The DEC-31 tick records `leftToBuy`.
  reserved: quantitySchema,
  leftToBuy: quantitySchema,
  // Reserved and nothing left to buy. The line shows "From storage" and has
  // no tick.
  fromStorage: z.boolean(),
  // Empty when nothing is held. Includes items this line already reserves
  // from, even if nothing more is available.
  stockItems: z.array(shoppingLineStockItemSchema),
});
export type ShoppingListLine = z.infer<typeof shoppingListLineSchema>;

export const shoppingListCategorySchema = z.object({
  category: z.object({
    id: categoryIdSchema,
    name: z.string(),
  }),
  lines: z.array(shoppingListLineSchema),
});
export type ShoppingListCategory = z.infer<typeof shoppingListCategorySchema>;

export const getShoppingListForPlanInputSchema = z.object({
  planId: planIdSchema,
});
export type GetShoppingListForPlanInput = z.infer<
  typeof getShoppingListForPlanInputSchema
>;

// A Staple on the list (DEC-118). `neededQuantity` is the plan's amount, or
// null when the plan doesn't use it and it's listed only to restock.
export const shoppingStapleLineSchema = z.object({
  ingredient: z.object({
    id: ingredientIdSchema,
    name: z.string(),
  }),
  unit: z.object({
    id: unitIdSchema,
    name: z.string(),
  }),
  location: storageLocationSchema,
  state: stapleStateSchema,
  neededQuantity: quantitySchema.nullable(),
  contributingSlots: z.array(shoppingListContributingSlotSchema),
  isChecked: z.boolean(),
});
export type ShoppingStapleLine = z.infer<typeof shoppingStapleLineSchema>;

export const getShoppingListForPlanResultSchema = z.object({
  planId: planIdSchema,
  // Lines to buy, Staples excluded.
  categories: z.array(shoppingListCategorySchema),
  // Running-low and out Staples, plus any ticked on this plan. Un-needed ones
  // appear only while the plan hasn't ended.
  staplesToRestock: z.array(shoppingStapleLineSchema),
  // In-stock Staples the plan needs. Shown collapsed, nothing to buy.
  staplesYouHave: z.array(shoppingStapleLineSchema),
  // The "Check your Staples and storage" banner, until dismissed.
  showStorageGlance: z.boolean(),
});
export type GetShoppingListForPlanResult = z.infer<
  typeof getShoppingListForPlanResultSchema
>;

// Toggle a single line's checked state. The server stamps the current
// aggregated total into `last_checked_quantity` on transition to true and
// clears it on transition to false (DEC-31). The client never supplies the
// quantity — preventing a stale snapshot from poisoning the reset invariant.
export const toggleShoppingItemCheckedInputSchema = z.object({
  planId: planIdSchema,
  ingredientId: ingredientIdSchema,
  isChecked: z.boolean(),
});
export type ToggleShoppingItemCheckedInput = z.infer<
  typeof toggleShoppingItemCheckedInputSchema
>;

export const toggleShoppingItemCheckedResultSchema = z.object({
  planId: planIdSchema,
  ingredientId: ingredientIdSchema,
  isChecked: z.boolean(),
});
export type ToggleShoppingItemCheckedResult = z.infer<
  typeof toggleShoppingItemCheckedResultSchema
>;

// What a line's sheet asks for (DEC-118). Each replaces the line's
// Reservations as a whole.
//   all:    what's needed, or everything available if less
//   none:   "Buy anyway"
//   amount: "Use some, buy the rest", drawn in the default order
//   draws:  the cook's own choice of items
export const lineReservationChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('amount'), amount: stockQuantitySchema }),
  z.object({
    kind: z.literal('draws'),
    draws: z
      .array(
        z.object({
          stockItemId: z.number().int().positive(),
          amount: stockQuantitySchema,
        }),
      )
      .min(1),
  }),
]);
export type LineReservationChoice = z.infer<typeof lineReservationChoiceSchema>;

export const setLineReservationsInputSchema = z.object({
  planId: planIdSchema,
  ingredientId: ingredientIdSchema,
  choice: lineReservationChoiceSchema,
});
export type SetLineReservationsInput = z.infer<
  typeof setLineReservationsInputSchema
>;

export const setLineReservationsResultSchema = z.object({
  planId: planIdSchema,
  ingredientId: ingredientIdSchema,
  reserved: quantitySchema,
});
export type SetLineReservationsResult = z.infer<
  typeof setLineReservationsResultSchema
>;

export const dismissStorageGlanceInputSchema = z.object({
  planId: planIdSchema,
});
export type DismissStorageGlanceInput = z.infer<
  typeof dismissStorageGlanceInputSchema
>;
