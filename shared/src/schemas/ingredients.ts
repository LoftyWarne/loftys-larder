import { z } from 'zod';

export const ingredientNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(120, 'Name must be 120 characters or fewer');

export const ingredientShelfLifeSchema = z
  .number()
  .int('Shelf life must be a whole number of days')
  .positive('Shelf life must be at least 1 day')
  .max(3650, 'Shelf life must be 3650 days or fewer');

const ingredientReferenceIdSchema = z.number().int().positive();

const ingredientIdSchema = z.number().int().positive();

// Editable fields on an ingredient. `averageShelfLifeDays` is `null` rather
// than `undefined` when cleared, mirroring the DB column.
const ingredientFieldsSchema = z.object({
  name: ingredientNameSchema,
  categoryId: ingredientReferenceIdSchema,
  defaultUnitId: ingredientReferenceIdSchema,
  isPlant: z.boolean(),
  averageShelfLifeDays: ingredientShelfLifeSchema.nullable(),
});

export const createIngredientInputSchema = ingredientFieldsSchema;

export type CreateIngredientInput = z.infer<typeof createIngredientInputSchema>;

export const updateIngredientInputSchema = z.object({
  id: ingredientIdSchema,
  patch: ingredientFieldsSchema
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
      message: 'Provide at least one field to update',
    }),
});

export type UpdateIngredientInput = z.infer<typeof updateIngredientInputSchema>;

export const listIngredientsInputSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
  })
  .optional();

export type ListIngredientsInput = z.infer<typeof listIngredientsInputSchema>;

export const deleteIngredientInputSchema = z.object({
  id: ingredientIdSchema,
});

export type DeleteIngredientInput = z.infer<typeof deleteIngredientInputSchema>;

// Lookup data driving the form's category + unit dropdowns. Lives on the
// ingredients router until a wider reference layer is needed (e.g. FEAT-21).
export const ingredientReferenceItemSchema = z.object({
  id: ingredientReferenceIdSchema,
  name: z.string(),
});

export type IngredientReferenceItem = z.infer<
  typeof ingredientReferenceItemSchema
>;

export const ingredientReferencesSchema = z.object({
  categories: z.array(ingredientReferenceItemSchema),
  units: z.array(ingredientReferenceItemSchema),
});

export type IngredientReferences = z.infer<typeof ingredientReferencesSchema>;

// Denormalised row for the Dictionary view — category + unit names are
// resolved server-side so the table can render without follow-up queries.
export const ingredientListItemSchema = z.object({
  id: ingredientIdSchema,
  name: z.string(),
  categoryId: ingredientReferenceIdSchema,
  categoryName: z.string(),
  defaultUnitId: ingredientReferenceIdSchema,
  defaultUnitName: z.string(),
  isPlant: z.boolean(),
  averageShelfLifeDays: z.number().int().positive().nullable(),
});

export type IngredientListItem = z.infer<typeof ingredientListItemSchema>;
