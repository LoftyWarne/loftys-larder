import { z } from 'zod';

const civilDateSchema = z.iso.date();
const stockItemIdSchema = z.number().int().positive();

export const STORAGE_LOCATIONS = ['freezer', 'fridge', 'pantry'] as const;

export const storageLocationSchema = z.enum(STORAGE_LOCATIONS);

export type StorageLocation = z.infer<typeof storageLocationSchema>;

const STOCK_QUANTITY_RE = /^\d+(\.\d{1,3})?$/;

// `numeric(10,3)` travels as a decimal string, like recipe quantities.
const stockQuantityStringSchema = z
  .string()
  .trim()
  .regex(
    STOCK_QUANTITY_RE,
    'Amount must be a number with up to 3 decimal places',
  )
  .refine((value) => Number(value) < 10_000_000, 'Amount is too large');

export const stockQuantitySchema = stockQuantityStringSchema.refine(
  (value) => Number(value) > 0,
  'Amount must be more than 0',
);

// An edit may bring an amount to zero, which deletes the item.
export const stockQuantityEditSchema = stockQuantityStringSchema;

// Recipe stock is counted in portions, whole or half.
export function isValidPortions(quantity: string): boolean {
  return Number.isInteger(Number(quantity) * 2);
}

export const stockTargetInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ingredient'),
    ingredientId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('recipe'),
    recipeId: z.number().int().positive(),
  }),
]);

export type StockTargetInput = z.infer<typeof stockTargetInputSchema>;

export const createStockItemInputSchema = z
  .object({
    location: storageLocationSchema,
    target: stockTargetInputSchema,
    quantity: stockQuantitySchema,
    addedOn: civilDateSchema,
    // Omitted: the default Use-by applies. Null: no Use-by.
    useBy: civilDateSchema.nullable().optional(),
  })
  .refine((value) => value.location === 'fridge' || value.useBy == null, {
    message: 'Only Fridge items have a Use-by',
    path: ['useBy'],
  })
  .refine(
    (value) =>
      value.target.kind !== 'recipe' || isValidPortions(value.quantity),
    { message: 'Portions must be whole or half', path: ['quantity'] },
  );

export type CreateStockItemInput = z.infer<typeof createStockItemInputSchema>;

export const updateStockItemInputSchema = z.object({
  id: stockItemIdSchema,
  patch: z
    .object({
      location: storageLocationSchema,
      quantity: stockQuantityEditSchema,
      addedOn: civilDateSchema,
      // On a move into the Fridge, omitted means a fresh default from today.
      useBy: civilDateSchema.nullable(),
    })
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
      message: 'Provide at least one field to update',
    }),
  // Set once the cook has agreed to release Reservations the new amount no
  // longer covers.
  releaseReservations: z.boolean().optional(),
});

export type UpdateStockItemInput = z.infer<typeof updateStockItemInputSchema>;

export const updateStockItemResultSchema = z.object({
  id: stockItemIdSchema,
  deleted: z.boolean(),
  releasedReservations: z.number().int().nonnegative(),
});

export type UpdateStockItemResult = z.infer<typeof updateStockItemResultSchema>;

export const deleteStockItemInputSchema = z.object({
  id: stockItemIdSchema,
  releaseReservations: z.boolean().optional(),
});

export type DeleteStockItemInput = z.infer<typeof deleteStockItemInputSchema>;

export const deleteStockItemResultSchema = z.object({
  id: stockItemIdSchema,
  releasedReservations: z.number().int().nonnegative(),
});

export type DeleteStockItemResult = z.infer<typeof deleteStockItemResultSchema>;

export const stockTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ingredient'),
    ingredientId: z.number().int().positive(),
    name: z.string(),
    unitName: z.string(),
    averageShelfLifeDays: z.number().int().positive().nullable(),
  }),
  z.object({
    kind: z.literal('recipe'),
    recipeId: z.number().int().positive(),
    name: z.string(),
    isBase: z.boolean(),
    isDeleted: z.boolean(),
  }),
]);

export type StockTarget = z.infer<typeof stockTargetSchema>;

export const stockItemSchema = z.object({
  id: stockItemIdSchema,
  location: storageLocationSchema,
  target: stockTargetSchema,
  quantity: z.string(),
  reserved: z.string(),
  addedOn: civilDateSchema,
  useBy: civilDateSchema.nullable(),
});

export type StockItem = z.infer<typeof stockItemSchema>;

export const listStorageResultSchema = z.object({
  // Europe/London, as the server settled against.
  today: civilDateSchema,
  items: z.array(stockItemSchema),
});

export type ListStorageResult = z.infer<typeof listStorageResultSchema>;

// URL search params for the Storage screen: the location tab.
export const storageSearchSchema = z.object({
  location: storageLocationSchema.optional().default('freezer'),
});

export type StorageSearch = z.infer<typeof storageSearchSchema>;

const formUseBySchema = z.union([civilDateSchema, z.literal('')]);

// The add sheet. `target` is null until something is picked; a blank Use-by
// is the date input's empty value.
export const stockItemAddFormSchema = z
  .object({
    location: storageLocationSchema,
    target: stockTargetInputSchema.nullable(),
    quantity: stockQuantitySchema,
    addedOn: civilDateSchema,
    useBy: formUseBySchema,
  })
  .refine((value) => value.target !== null, {
    message: 'Pick an ingredient or dish',
    path: ['target'],
  })
  .refine(
    (value) =>
      value.target?.kind !== 'recipe' || isValidPortions(value.quantity),
    { message: 'Portions must be whole or half', path: ['quantity'] },
  );

export type StockItemAddForm = z.input<typeof stockItemAddFormSchema>;

// The edit sheet. Zero deletes the item. Portions are checked against the
// item's kind by the sheet.
export const stockItemEditFormSchema = z.object({
  location: storageLocationSchema,
  quantity: stockQuantityEditSchema,
  addedOn: civilDateSchema,
  useBy: formUseBySchema,
});

export type StockItemEditForm = z.input<typeof stockItemEditFormSchema>;
