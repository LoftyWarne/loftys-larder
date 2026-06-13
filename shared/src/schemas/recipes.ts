import { z } from 'zod';

// Recipe DTOs. Reads are split into a list shape (browse cards, picker rows)
// and a detail shape (`recipes.get`). Both are consumed by downstream features
// (editor, planner sidebar, related-recipes UI, shopping list) — adding fields
// is cheap, restructuring is invasive (cross-cutting concern #9). All text
// fields are plain text rendered through React's default escaping (DEC-49).

const recipeIdSchema = z.number().int().positive();
const ingredientIdSchema = z.number().int().positive();
const unitIdSchema = z.number().int().positive();
const prepTypeIdSchema = z.number().int().positive();
const sourceIdSchema = z.number().int().positive();
const ratingSchema = z.number().int().min(1).max(5);

export const recipeIngredientLineSchema = z.object({
  id: z.number().int().positive(),
  ingredientId: ingredientIdSchema,
  ingredientName: z.string(),
  // numeric(10,3) — kept as string so callers don't lose precision on
  // fractional quantities (the editor reads back what the user typed).
  quantity: z.string(),
  unitId: unitIdSchema,
  unitName: z.string(),
  prepTypeId: prepTypeIdSchema.nullable(),
  prepTypeName: z.string().nullable(),
  isPlant: z.boolean(),
});

export type RecipeIngredientLine = z.infer<typeof recipeIngredientLineSchema>;

export const recipeMethodStepSchema = z.object({
  id: z.number().int().positive(),
  stepNumber: z.number().int().positive(),
  instruction: z.string(),
});

export type RecipeMethodStep = z.infer<typeof recipeMethodStepSchema>;

// Browse card / picker row.
export const recipeListItemSchema = z.object({
  id: recipeIdSchema,
  name: z.string(),
  imageUrl: z.string().nullable(),
  baseServings: z.number().int().positive(),
  activeTimeMins: z.number().int().nonnegative().nullable(),
  totalTimeMins: z.number().int().nonnegative().nullable(),
  isBase: z.boolean(),
  baseRecipeId: recipeIdSchema.nullable(),
  pairedRecipeId: recipeIdSchema.nullable(),
  isDeleted: z.boolean(),
  // Server-computed: COUNT(DISTINCT ingredient_id WHERE is_plant) (DEC-32).
  plantPointsCount: z.number().int().nonnegative(),
});

export type RecipeListItem = z.infer<typeof recipeListItemSchema>;

// `recipes.get` detail. Soft-deleted recipes are still returned (DEC-21) so
// historical plans render their reference.
export const recipeSchema = recipeListItemSchema.extend({
  description: z.string().nullable(),
  sourceId: sourceIdSchema.nullable(),
  sourceName: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  estimatedCostPerServing: z.string().nullable(),
  caloriesPerServing: z.number().int().nullable(),
  proteinPerServing: z.number().int().nullable(),
  carbsPerServing: z.number().int().nullable(),
  fatPerServing: z.number().int().nullable(),
  saturatedFatPerServing: z.number().int().nullable(),
  fibrePerServing: z.number().int().nullable(),
  sugarPerServing: z.number().int().nullable(),
  saltPerServing: z.number().int().nullable(),
  addedByUserId: z.string().nullable(),
  ingredients: z.array(recipeIngredientLineSchema),
  method: z.array(recipeMethodStepSchema),
  averageRating: z.number().nullable(),
  ratingCount: z.number().int().nonnegative(),
  yourRating: ratingSchema.nullable(),
});

export type Recipe = z.infer<typeof recipeSchema>;

export const listRecipesCursorSchema = z.object({
  lowerName: z.string(),
  id: recipeIdSchema,
});

export type ListRecipesCursor = z.infer<typeof listRecipesCursorSchema>;

// `includePickerHidden` is accepted now and threaded into the helper as a
// no-op. FEAT-23 fills in the batch-version-of-deleted-base rule without
// reshaping this input.
export const listRecipesInputSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    includeDeleted: z.boolean().optional(),
    includePickerHidden: z.boolean().optional(),
    cursor: listRecipesCursorSchema.optional(),
    limit: z.number().int().min(1).max(60).optional(),
  })
  .optional();

export type ListRecipesInput = z.infer<typeof listRecipesInputSchema>;

export const listRecipesResultSchema = z.object({
  items: z.array(recipeListItemSchema),
  nextCursor: listRecipesCursorSchema.nullable(),
});

export type ListRecipesResult = z.infer<typeof listRecipesResultSchema>;

export const getRecipeInputSchema = z.object({
  id: recipeIdSchema,
});

export type GetRecipeInput = z.infer<typeof getRecipeInputSchema>;

// `smallint` max — clamps the macros / serving / time inputs at the boundary
// so out-of-range values never reach the database.
const SMALLINT_MAX = 32767;

const recipeNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(200, 'Name must be 200 characters or fewer');

const recipeDescriptionSchema = z.string().trim().min(1).max(5000).nullable();
const recipeImageUrlSchema = z.string().trim().min(1).max(2000).nullable();
const recipeSourceUrlSchema = z.string().trim().min(1).max(2000).nullable();
const recipeServingsSchema = z.number().int().min(1).max(SMALLINT_MAX);
const recipeTimeSchema = z.number().int().min(0).max(SMALLINT_MAX).nullable();
const recipeMacroSchema = z.number().int().min(0).max(SMALLINT_MAX).nullable();
const recipeMoneySchema = z
  .string()
  .regex(
    /^\d+(\.\d{1,2})?$/,
    'Cost must be a non-negative number with up to 2 decimal places',
  )
  .nullable();
const recipeQuantitySchema = z
  .string()
  .regex(
    /^\d+(\.\d{1,3})?$/,
    'Quantity must be a non-negative number with up to 3 decimal places',
  );
const recipeInstructionSchema = z.string().trim().min(1).max(5000);

// Fields editable on the recipe header via `create` and `updateHeader`.
// Deliberately excludes `isBase`, `baseRecipeId`, and `pairedRecipeId` — those
// belong to the batch model surface (FEAT-23), which owns the pair-symmetry
// transaction and the XOR enforcement against `is_base`. `isBase` is allowed
// at create time so a household can mark a recipe as a base from the start
// without round-tripping through FEAT-23's editor.
const recipeHeaderWritableSchema = z.object({
  name: recipeNameSchema,
  description: recipeDescriptionSchema,
  imageUrl: recipeImageUrlSchema,
  baseServings: recipeServingsSchema,
  activeTimeMins: recipeTimeSchema,
  totalTimeMins: recipeTimeSchema,
  estimatedCostPerServing: recipeMoneySchema,
  sourceId: sourceIdSchema.nullable(),
  sourceUrl: recipeSourceUrlSchema,
  caloriesPerServing: recipeMacroSchema,
  proteinPerServing: recipeMacroSchema,
  carbsPerServing: recipeMacroSchema,
  fatPerServing: recipeMacroSchema,
  saturatedFatPerServing: recipeMacroSchema,
  fibrePerServing: recipeMacroSchema,
  sugarPerServing: recipeMacroSchema,
  saltPerServing: recipeMacroSchema,
});

export const createRecipeInputSchema = recipeHeaderWritableSchema
  .partial()
  .extend({
    name: recipeNameSchema,
    baseServings: recipeServingsSchema,
    isBase: z.boolean().optional(),
  });

export type CreateRecipeInput = z.infer<typeof createRecipeInputSchema>;

export const createRecipeResultSchema = z.object({
  id: recipeIdSchema,
});

export type CreateRecipeResult = z.infer<typeof createRecipeResultSchema>;

export const updateRecipeHeaderInputSchema = z.object({
  id: recipeIdSchema,
  patch: recipeHeaderWritableSchema
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
      message: 'Provide at least one field to update',
    }),
});

export type UpdateRecipeHeaderInput = z.infer<
  typeof updateRecipeHeaderInputSchema
>;

export const updateRecipeHeaderResultSchema = z.object({
  id: recipeIdSchema,
});

export type UpdateRecipeHeaderResult = z.infer<
  typeof updateRecipeHeaderResultSchema
>;

export const replaceRecipeIngredientsLineSchema = z.object({
  ingredientId: ingredientIdSchema,
  quantity: recipeQuantitySchema,
  unitId: unitIdSchema,
  prepTypeId: prepTypeIdSchema.nullable(),
});

export type ReplaceRecipeIngredientsLine = z.infer<
  typeof replaceRecipeIngredientsLineSchema
>;

export const replaceRecipeIngredientsInputSchema = z.object({
  recipeId: recipeIdSchema,
  lines: z.array(replaceRecipeIngredientsLineSchema).max(200),
});

export type ReplaceRecipeIngredientsInput = z.infer<
  typeof replaceRecipeIngredientsInputSchema
>;

export const replaceRecipeIngredientsResultSchema = z.object({
  recipeId: recipeIdSchema,
  count: z.number().int().nonnegative(),
});

export type ReplaceRecipeIngredientsResult = z.infer<
  typeof replaceRecipeIngredientsResultSchema
>;

export const replaceRecipeMethodStepInputSchema = z.object({
  instruction: recipeInstructionSchema,
});

export type ReplaceRecipeMethodStepInput = z.infer<
  typeof replaceRecipeMethodStepInputSchema
>;

export const replaceRecipeMethodInputSchema = z.object({
  recipeId: recipeIdSchema,
  steps: z.array(replaceRecipeMethodStepInputSchema).max(200),
});

export type ReplaceRecipeMethodInput = z.infer<
  typeof replaceRecipeMethodInputSchema
>;

export const replaceRecipeMethodResultSchema = z.object({
  recipeId: recipeIdSchema,
  count: z.number().int().nonnegative(),
});

export type ReplaceRecipeMethodResult = z.infer<
  typeof replaceRecipeMethodResultSchema
>;

export const setRecipeDeletionInputSchema = z.object({
  id: recipeIdSchema,
});

export type SetRecipeDeletionInput = z.infer<
  typeof setRecipeDeletionInputSchema
>;

export const setRecipeDeletionResultSchema = z.object({
  id: recipeIdSchema,
  isDeleted: z.boolean(),
});

export type SetRecipeDeletionResult = z.infer<
  typeof setRecipeDeletionResultSchema
>;
