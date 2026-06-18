import { z } from 'zod';

// Shopping list DTOs. Read-side aggregation for a plan (DEC-19 scaling,
// DEC-26 cooks-base contributions, DEC-23 batch-version no-double-count).
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
  shelfLifeWarning: shelfLifeWarningSchema.optional(),
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

export const getShoppingListForPlanResultSchema = z.object({
  planId: planIdSchema,
  categories: z.array(shoppingListCategorySchema),
});
export type GetShoppingListForPlanResult = z.infer<
  typeof getShoppingListForPlanResultSchema
>;
