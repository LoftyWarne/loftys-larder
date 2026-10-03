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
export const ratingSchema = z.number().int().min(1).max(5);

// `smallint` max — clamps the macros / serving / time inputs at the boundary
// so out-of-range values never reach the database.
const SMALLINT_MAX = 32767;

export type Rating = z.infer<typeof ratingSchema>;

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
  // Optional lines still carry a quantity (DEC-19) and still reach the
  // shopping list, flagged; they don't count towards plant points.
  isOptional: z.boolean(),
});

export type RecipeIngredientLine = z.infer<typeof recipeIngredientLineSchema>;

// `optional` = can be done ahead; `required` = must be started ahead
// (marinating, soaking). `null` is an ordinary on-the-day step (DEC-96).
export const stepPrepAheadSchema = z.enum(['optional', 'required']);

export type StepPrepAhead = z.infer<typeof stepPrepAheadSchema>;

// An ingredient a method step uses (DEC-99). Linked by the household
// ingredient, not by a recipe line. `quantity` is the amount used in this
// step, in the ingredient's one unit, as a `numeric(10,3)` string; `null`
// means not stated.
export const recipeStepIngredientSchema = z.object({
  ingredientId: ingredientIdSchema,
  quantity: z.string().nullable(),
});

export type RecipeStepIngredient = z.infer<typeof recipeStepIngredientSchema>;

export const recipeMethodStepSchema = z.object({
  id: z.number().int().positive(),
  stepNumber: z.number().int().positive(),
  instruction: z.string(),
  safetyNote: z.string().nullable(),
  tip: z.string().nullable(),
  prepAhead: stepPrepAheadSchema.nullable(),
  ingredients: z.array(recipeStepIngredientSchema),
});

export type RecipeMethodStep = z.infer<typeof recipeMethodStepSchema>;

// Free-form organising tags (DEC-97). Names are plain text (DEC-49); the
// household vocabulary is case-insensitively unique, so the first spelling
// used is the one kept.
export const RECIPE_TAG_NAME_MAX_LENGTH = 40;
export const RECIPE_TAGS_MAX = 10;

const recipeTagIdSchema = z.number().int().positive();

export function normaliseRecipeTagName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export const recipeTagNameSchema = z
  .string()
  .transform(normaliseRecipeTagName)
  .pipe(
    z
      .string()
      .min(1, 'Tag cannot be blank')
      .max(
        RECIPE_TAG_NAME_MAX_LENGTH,
        `Tag must be ${String(RECIPE_TAG_NAME_MAX_LENGTH)} characters or fewer`,
      ),
  );

export const recipeTagSchema = z.object({
  id: recipeTagIdSchema,
  name: z.string(),
});

export type RecipeTag = z.infer<typeof recipeTagSchema>;

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
  isDeleted: z.boolean(),
  // Server-computed: COUNT(DISTINCT ingredient_id WHERE is_plant) (DEC-32).
  plantPointsCount: z.number().int().nonnegative(),
  // Aggregate over `recipe_ratings`; `null` average when no ratings exist.
  averageRating: z.number().nullable(),
  ratingCount: z.number().int().nonnegative(),
  // Sorted by name, case-insensitively.
  tags: z.array(recipeTagSchema),
});

export type RecipeListItem = z.infer<typeof recipeListItemSchema>;

// `recipes.get` detail. Soft-deleted recipes are still returned (DEC-21) so
// historical plans render their reference. The base recipe's name + its
// `isDeleted` flag are denormalised onto the row so the serving-variation
// editor can render the affordance + a "(deleted)" hint without a second
// round-trip.
export const recipeSchema = recipeListItemSchema.extend({
  description: z.string().nullable(),
  sourceId: sourceIdSchema.nullable(),
  sourceName: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceDetail: z.string().nullable(),
  estimatedCostPerServing: z.string().nullable(),
  caloriesPerServing: z.number().int().nullable(),
  proteinPerServing: z.number().nullable(),
  carbsPerServing: z.number().nullable(),
  fatPerServing: z.number().nullable(),
  saturatedFatPerServing: z.number().nullable(),
  fibrePerServing: z.number().nullable(),
  sugarPerServing: z.number().nullable(),
  saltPerServing: z.number().nullable(),
  addedByUserId: z.string().nullable(),
  baseRecipeName: z.string().nullable(),
  baseRecipeIsDeleted: z.boolean().nullable(),
  ingredients: z.array(recipeIngredientLineSchema),
  method: z.array(recipeMethodStepSchema),
  yourRating: ratingSchema.nullable(),
});

export type Recipe = z.infer<typeof recipeSchema>;

export const listRecipesCursorSchema = z.object({
  lowerName: z.string(),
  id: recipeIdSchema,
});

export type ListRecipesCursor = z.infer<typeof listRecipesCursorSchema>;

// Recipes-page filters (DEC-100).
export const RECIPE_FILTER_SOURCES_MAX = 20;
export const RECIPE_FILTER_INGREDIENTS_MAX = 10;

export const recipeTimeLimitSchema = z.number().int().min(1).max(SMALLINT_MAX);

// `includePickerHidden` now excludes serving variations whose base is
// soft-deleted (the three-way model's "new picker" rule); `isBase` lets the
// base picker filter to bases only. Both forward to `pickableRecipesWhere`.
export const listRecipesInputSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    includeDeleted: z.boolean().optional(),
    includePickerHidden: z.boolean().optional(),
    isBase: z.boolean().optional(),
    // A recipe must carry every listed tag (AND).
    tagIds: z.array(recipeTagIdSchema).max(RECIPE_TAGS_MAX).optional(),
    // A recipe has one source, so several listed means any of them.
    sourceIds: z
      .array(sourceIdSchema)
      .max(RECIPE_FILTER_SOURCES_MAX)
      .optional(),
    // A recipe must use every listed ingredient (AND); a serving variation
    // also matches on its base recipe's lines.
    ingredientIds: z
      .array(ingredientIdSchema)
      .max(RECIPE_FILTER_INGREDIENTS_MAX)
      .optional(),
    // Inclusive upper bounds; a recipe with no time recorded never matches.
    maxActiveTimeMins: recipeTimeLimitSchema.optional(),
    maxTotalTimeMins: recipeTimeLimitSchema.optional(),
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

const recipeNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(200, 'Name must be 200 characters or fewer');

const recipeDescriptionSchema = z.string().trim().min(1).max(5000).nullable();
const recipeImageUrlSchema = z.string().trim().min(1).max(2000).nullable();
const recipeSourceUrlSchema = z.string().trim().min(1).max(2000).nullable();
const recipeSourceDetailSchema = z.string().trim().min(1).max(500).nullable();
const recipeSourceNameSchema = z
  .string()
  .trim()
  .min(1, 'Source name is required')
  .max(200, 'Source name must be 200 characters or fewer');

// Inline source creation from the recipe editor — mirrors createIngredientInput.
export const createSourceInputSchema = z.object({
  name: recipeSourceNameSchema,
});

export type CreateSourceInput = z.infer<typeof createSourceInputSchema>;
const recipeServingsSchema = z.number().int().min(1).max(SMALLINT_MAX);
const recipeTimeSchema = z.number().int().min(0).max(SMALLINT_MAX).nullable();
const recipeCaloriesSchema = z
  .number()
  .int()
  .min(0)
  .max(SMALLINT_MAX)
  .nullable();
// `numeric(6,2)` — two decimal places, max 9999.99 g per serving.
const recipeMacroGramsSchema = z
  .number()
  .min(0)
  .max(9999.99)
  .multipleOf(0.01, 'Use at most 2 decimal places')
  .nullable();
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
export const RECIPE_INSTRUCTION_MAX_LENGTH = 5000;
const recipeInstructionSchema = z
  .string()
  .trim()
  .min(1)
  .max(
    RECIPE_INSTRUCTION_MAX_LENGTH,
    `Step text must be ${String(RECIPE_INSTRUCTION_MAX_LENGTH)} characters or fewer`,
  );

export const RECIPE_STEP_NOTE_MAX_LENGTH = 1000;
// Blank is rejected rather than coerced to null: the editor sends `null` for
// "no note", so there is exactly one stored form (DEC-94).
const recipeStepNoteSchema = z
  .string()
  .trim()
  .min(1, 'Note cannot be blank')
  .max(
    RECIPE_STEP_NOTE_MAX_LENGTH,
    `Note must be ${String(RECIPE_STEP_NOTE_MAX_LENGTH)} characters or fewer`,
  );

// Fields editable on the recipe header via `create` and `updateHeader`.
// Deliberately excludes `isBase` and `baseRecipeId` — those belong to the
// serving-variation surface, which owns the XOR enforcement against `is_base`.
// `isBase` is allowed at create time so a household can mark a recipe as a base
// from the start without round-tripping through the serving-variation editor.
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
  sourceDetail: recipeSourceDetailSchema,
  caloriesPerServing: recipeCaloriesSchema,
  proteinPerServing: recipeMacroGramsSchema,
  carbsPerServing: recipeMacroGramsSchema,
  fatPerServing: recipeMacroGramsSchema,
  saturatedFatPerServing: recipeMacroGramsSchema,
  fibrePerServing: recipeMacroGramsSchema,
  sugarPerServing: recipeMacroGramsSchema,
  saltPerServing: recipeMacroGramsSchema,
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
  isOptional: z.boolean(),
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

export const RECIPE_STEP_INGREDIENTS_MAX = 50;

export const replaceRecipeMethodStepIngredientSchema = z.object({
  ingredientId: ingredientIdSchema,
  quantity: recipeQuantitySchema
    .refine((value) => Number(value) > 0, 'Amount must be more than 0')
    .nullable(),
});

export type ReplaceRecipeMethodStepIngredient = z.infer<
  typeof replaceRecipeMethodStepIngredientSchema
>;

export const replaceRecipeMethodStepInputSchema = z.object({
  instruction: recipeInstructionSchema,
  safetyNote: recipeStepNoteSchema.nullable(),
  tip: recipeStepNoteSchema.nullable(),
  prepAhead: stepPrepAheadSchema.nullable(),
  ingredients: z
    .array(replaceRecipeMethodStepIngredientSchema)
    .max(RECIPE_STEP_INGREDIENTS_MAX)
    .refine(
      (links) =>
        new Set(links.map((link) => link.ingredientId)).size === links.length,
      'Each ingredient can only be listed once per step',
    ),
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

// Full replace by *name*: unknown names become new household tags, known ones
// (matched case-insensitively) are reused (DEC-97).
export const replaceRecipeTagsInputSchema = z.object({
  recipeId: recipeIdSchema,
  names: z.array(recipeTagNameSchema).max(RECIPE_TAGS_MAX),
});

export type ReplaceRecipeTagsInput = z.infer<
  typeof replaceRecipeTagsInputSchema
>;

export const replaceRecipeTagsResultSchema = z.object({
  recipeId: recipeIdSchema,
  tags: z.array(recipeTagSchema),
});

export type ReplaceRecipeTagsResult = z.infer<
  typeof replaceRecipeTagsResultSchema
>;

// Tags linked to at least one pickable recipe, sorted by name.
export const listRecipeTagsResultSchema = z.array(recipeTagSchema);

export type ListRecipeTagsResult = z.infer<typeof listRecipeTagsResultSchema>;

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

// Serving-variation edit surface. `updateHeader` deliberately refuses these
// fields; this procedure owns the XOR enforcement against `is_base` (DEC-23).
// At least one field must be present so the procedure always represents a real
// intent.
export const setRecipeServingVariationFieldsInputSchema = z
  .object({
    id: recipeIdSchema,
    isBase: z.boolean().optional(),
    baseRecipeId: recipeIdSchema.nullable().optional(),
  })
  .refine(
    (value) => value.isBase !== undefined || value.baseRecipeId !== undefined,
    { message: 'Provide at least one field to update' },
  );

export type SetRecipeServingVariationFieldsInput = z.infer<
  typeof setRecipeServingVariationFieldsInputSchema
>;

export const setRecipeServingVariationFieldsResultSchema = z.object({
  id: recipeIdSchema,
  isBase: z.boolean(),
  baseRecipeId: recipeIdSchema.nullable(),
});

export type SetRecipeServingVariationFieldsResult = z.infer<
  typeof setRecipeServingVariationFieldsResultSchema
>;

// Lookup data driving the recipe editor's unit / prep-type / source pickers.
// `units` and `prepTypes` are global reference tables; `sources` is scoped to
// the current household per DEC-17 — closes the cross-household source hole
// flagged in session notes (the `sourceId` accepted by `create`/`updateHeader`
// is now also scope-checked against this list at write time).
export const recipeReferenceItemSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
});

export type RecipeReferenceItem = z.infer<typeof recipeReferenceItemSchema>;

export const recipeReferencesSchema = z.object({
  units: z.array(recipeReferenceItemSchema),
  prepTypes: z.array(recipeReferenceItemSchema),
  sources: z.array(recipeReferenceItemSchema),
});

export type RecipeReferences = z.infer<typeof recipeReferencesSchema>;

// Recipes-page filter options (DEC-100): sources and ingredients on at least
// one listed recipe, sorted by name.
export const listRecipeSourcesResultSchema = z.array(recipeReferenceItemSchema);

export type ListRecipeSourcesResult = z.infer<
  typeof listRecipeSourcesResultSchema
>;

export const listRecipeIngredientsResultSchema = z.array(
  recipeReferenceItemSchema,
);

export type ListRecipeIngredientsResult = z.infer<
  typeof listRecipeIngredientsResultSchema
>;

export const rateRecipeInputSchema = z.object({
  recipeId: recipeIdSchema,
  rating: ratingSchema,
});

export type RateRecipeInput = z.infer<typeof rateRecipeInputSchema>;

export const rateRecipeResultSchema = z.object({
  recipeId: recipeIdSchema,
  rating: ratingSchema,
});

export type RateRecipeResult = z.infer<typeof rateRecipeResultSchema>;

export const unrateRecipeInputSchema = z.object({
  recipeId: recipeIdSchema,
});

export type UnrateRecipeInput = z.infer<typeof unrateRecipeInputSchema>;

export const unrateRecipeResultSchema = z.object({
  recipeId: recipeIdSchema,
});

export type UnrateRecipeResult = z.infer<typeof unrateRecipeResultSchema>;

// Recipe comments (FEAT-25). Authored text is plain string per DEC-49 — never
// markdown, never HTML, never interpreted by `dangerouslySetInnerHTML`.
// `userId` is nullable: the tombstoning sequence (DEC-29) SETs NULL when the
// author leaves; the UI renders `[deleted user]` then. `lastUpdatedAt` is
// likewise nullable — NULL means "never edited", which is how the UI infers
// the "(edited)" affordance.
export const RECIPE_COMMENT_MAX_LENGTH = 2000;

const recipeCommentTextSchema = z
  .string()
  .trim()
  .min(1, 'Comment cannot be empty')
  .max(
    RECIPE_COMMENT_MAX_LENGTH,
    `Comment must be ${String(RECIPE_COMMENT_MAX_LENGTH)} characters or fewer`,
  );

const recipeCommentIdSchema = z.number().int().positive();

// `createdAt` / `lastUpdatedAt` are ISO-8601 strings on the wire — the
// project doesn't run a tRPC data transformer, so Date round-trips as a
// string anyway (matches the `lastUpdatedAt: number` pattern in recipe
// drafts; strings here so the UI can `new Date(s)` directly).
export const recipeCommentSchema = z.object({
  id: recipeCommentIdSchema,
  recipeId: recipeIdSchema,
  userId: z.string().nullable(),
  authorName: z.string().nullable(),
  comment: z.string(),
  createdAt: z.string(),
  lastUpdatedAt: z.string().nullable(),
});

export type RecipeComment = z.infer<typeof recipeCommentSchema>;

export const addRecipeCommentInputSchema = z.object({
  recipeId: recipeIdSchema,
  comment: recipeCommentTextSchema,
});

export type AddRecipeCommentInput = z.infer<typeof addRecipeCommentInputSchema>;

export const addRecipeCommentResultSchema = recipeCommentSchema;

export type AddRecipeCommentResult = z.infer<
  typeof addRecipeCommentResultSchema
>;

export const editRecipeCommentInputSchema = z.object({
  id: recipeCommentIdSchema,
  comment: recipeCommentTextSchema,
});

export type EditRecipeCommentInput = z.infer<
  typeof editRecipeCommentInputSchema
>;

export const editRecipeCommentResultSchema = recipeCommentSchema;

export type EditRecipeCommentResult = z.infer<
  typeof editRecipeCommentResultSchema
>;

export const deleteRecipeCommentInputSchema = z.object({
  id: recipeCommentIdSchema,
});

export type DeleteRecipeCommentInput = z.infer<
  typeof deleteRecipeCommentInputSchema
>;

export const deleteRecipeCommentResultSchema = z.object({
  id: recipeCommentIdSchema,
});

export type DeleteRecipeCommentResult = z.infer<
  typeof deleteRecipeCommentResultSchema
>;

export const listRecipeCommentsInputSchema = z.object({
  recipeId: recipeIdSchema,
});

export type ListRecipeCommentsInput = z.infer<
  typeof listRecipeCommentsInputSchema
>;

export const listRecipeCommentsResultSchema = z.object({
  items: z.array(recipeCommentSchema),
});

export type ListRecipeCommentsResult = z.infer<
  typeof listRecipeCommentsResultSchema
>;

// Related recipes. The DB table `related_recipes` enforces the symmetric pair
// (composite PK + CHECK recipe_one_id < recipe_two_id, DEC-27); these DTOs
// carry the unordered pair as seen by the caller — `recipeId` is whichever
// side is anchoring the read or write.
export const addRelatedRecipeInputSchema = z.object({
  recipeId: recipeIdSchema,
  otherRecipeId: recipeIdSchema,
});

export type AddRelatedRecipeInput = z.infer<typeof addRelatedRecipeInputSchema>;

export const addRelatedRecipeResultSchema = z.object({
  recipeId: recipeIdSchema,
  otherRecipeId: recipeIdSchema,
});

export type AddRelatedRecipeResult = z.infer<
  typeof addRelatedRecipeResultSchema
>;

export const removeRelatedRecipeInputSchema = z.object({
  recipeId: recipeIdSchema,
  otherRecipeId: recipeIdSchema,
});

export type RemoveRelatedRecipeInput = z.infer<
  typeof removeRelatedRecipeInputSchema
>;

export const removeRelatedRecipeResultSchema = z.object({
  recipeId: recipeIdSchema,
  otherRecipeId: recipeIdSchema,
});

export type RemoveRelatedRecipeResult = z.infer<
  typeof removeRelatedRecipeResultSchema
>;

export const listRelatedRecipesInputSchema = z.object({
  recipeId: recipeIdSchema,
});

export type ListRelatedRecipesInput = z.infer<
  typeof listRelatedRecipesInputSchema
>;

export const relatedRecipeItemSchema = z.object({
  id: recipeIdSchema,
  name: z.string(),
  imageUrl: z.string().nullable(),
});

export type RelatedRecipeItem = z.infer<typeof relatedRecipeItemSchema>;

export const listRelatedRecipesResultSchema = z.object({
  items: z.array(relatedRecipeItemSchema),
});

export type ListRelatedRecipesResult = z.infer<
  typeof listRelatedRecipesResultSchema
>;
