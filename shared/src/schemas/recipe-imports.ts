import { z } from 'zod';

import {
  createIngredientInputSchema,
  ingredientNameSchema,
  ingredientShelfLifeSchema,
} from './ingredients.ts';
import { recipeDraftEnvelopeSchema } from './recipe-drafts.ts';
import {
  RECIPE_TAGS_MAX,
  recipeHeaderWritableSchema,
  recipeImageViewSchema,
  recipeInstructionSchema,
  recipeQuantitySchema,
  recipeSourceNameSchema,
  recipeStepAmountSchema,
  recipeStepNoteSchema,
  recipeTagNameSchema,
  stepPrepAheadSchema,
} from './recipes.ts';
import { RECIPE_IMPORT_IMAGE_FOLDER } from './uploads.ts';

// Recipe Import (DEC-103 to DEC-109). Three shapes with one owner each
// (DEC-108): the proposal, written into an import draft once by the server;
// the editor's sections, owned by the editor; and the create-from-import
// input, sent by the client. The candidate is what a reader adapter returns
// before `normaliseProposal` checks it.

const idSchema = z.number().int().positive();
const draftIdSchema = z.number().int().positive();

export const RECIPE_IMPORT_TEXT_MAX_LENGTH = 20_000;
export const RECIPE_IMPORT_IMAGES_MAX = 8;
export const RECIPE_IMPORT_NOTES_MAX = 5;
export const RECIPE_IMPORT_NOTE_MAX_LENGTH = 300;
export const RECIPE_IMPORT_SEVERAL_MAX = 10;
export const RECIPE_IMPORT_ORIGINAL_LINE_MAX_LENGTH = 500;
const RECIPE_IMPORT_ROWS_MAX = 200;
const RECIPE_IMPORT_ESTIMATES_MAX = 1000;

const recipeImportPickSchema = z.string().trim().min(1).max(200);

// --- Import input -----------------------------------------------------------

// Only images in the imports folder, so discarding an import can never
// delete a recipe image (DEC-107). The cook's autosave sends the proposal
// back, so this is checked wherever the ids are read.
const IMPORT_IMAGE_PREFIX = `${RECIPE_IMPORT_IMAGE_FOLDER}/`;

export const recipeImportImagePublicIdSchema = z
  .string()
  .max(255)
  .refine(
    (publicId) =>
      publicId.startsWith(IMPORT_IMAGE_PREFIX) &&
      /^[A-Za-z0-9_-]+$/.test(publicId.slice(IMPORT_IMAGE_PREFIX.length)),
    'Not an import image',
  );

// Web links will join this union.
export const recipeImportInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string().trim().min(1).max(RECIPE_IMPORT_TEXT_MAX_LENGTH),
  }),
  // In page order.
  z.object({
    kind: z.literal('images'),
    publicIds: z
      .array(recipeImportImagePublicIdSchema)
      .min(1)
      .max(RECIPE_IMPORT_IMAGES_MAX)
      .refine(
        (publicIds) => new Set(publicIds).size === publicIds.length,
        'Each image can only be used once',
      ),
  }),
]);

export type RecipeImportInput = z.infer<typeof recipeImportInputSchema>;

export const recipeImportInputKindSchema = z.enum(['text', 'images']);

export type RecipeImportInputKind = z.infer<typeof recipeImportInputKindSchema>;

// --- Start ------------------------------------------------------------------

// "Several" creates no draft: the client calls `start` again with the same
// input and the picked name (DEC-103).
export const startRecipeImportInputSchema = z.object({
  input: recipeImportInputSchema,
  pick: recipeImportPickSchema.optional(),
});

export type StartRecipeImportInput = z.infer<
  typeof startRecipeImportInputSchema
>;

export const startRecipeImportResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draft'), draftId: draftIdSchema }),
  z.object({
    kind: z.literal('several'),
    names: z
      .array(recipeImportPickSchema)
      .min(2)
      .max(RECIPE_IMPORT_SEVERAL_MAX),
  }),
]);

export type StartRecipeImportResult = z.infer<
  typeof startRecipeImportResultSchema
>;

// --- Candidate (reader output, before normalisation) ------------------------

// Kept to what structured outputs can express: every key present, no length
// or range limits, no records. The limits live in the proposal schema, which
// `normaliseProposal` parses into. Structured outputs also allow only a few
// union-typed properties (nullable ones count), so where a value can simply
// be missing it's an empty string or a list entry rather than a null.
const candidateIngredientRefSchema = z.union([
  z.strictObject({ id: z.number().int(), name: z.string() }),
  z.strictObject({ newKey: z.string() }),
]);

export const RECIPE_IMPORT_NUTRITION_FIELDS = [
  'caloriesPerServing',
  'proteinPerServing',
  'carbsPerServing',
  'fatPerServing',
  'saturatedFatPerServing',
  'fibrePerServing',
  'sugarPerServing',
  'saltPerServing',
] as const;

export type RecipeImportNutritionField =
  (typeof RECIPE_IMPORT_NUTRITION_FIELDS)[number];

export const recipeImportCandidateSchema = z.object({
  header: z.object({
    name: z.string(),
    // Empty when there's none, as for the source fields.
    description: z.string(),
    baseServings: z.number(),
    activeTimeMins: z.number().nullable(),
    totalTimeMins: z.number().nullable(),
    // Only the values the reader has; a field left out has none.
    nutrition: z.array(
      z.object({
        field: z.enum(RECIPE_IMPORT_NUTRITION_FIELDS),
        value: z.number(),
      }),
    ),
    sourceUrl: z.string(),
    sourceDetail: z.string(),
  }),
  source: z
    .union([
      z.strictObject({ id: z.number().int() }),
      z.strictObject({ newName: z.string() }),
    ])
    .nullable(),
  newIngredients: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      categoryId: z.number().int().nullable(),
      defaultUnitId: z.number().int().nullable(),
      isPlant: z.boolean(),
      averageShelfLifeDays: z.number().nullable(),
    }),
  ),
  ingredients: z.array(
    z.object({
      key: z.string(),
      ingredient: candidateIngredientRefSchema,
      quantity: z.number(),
      prepTypeId: z.number().int().nullable(),
      isOptional: z.boolean(),
      originalLine: z.string(),
    }),
  ),
  method: z.array(
    z.object({
      key: z.string(),
      instruction: z.string(),
      safetyNote: z.string().nullable(),
      tip: z.string().nullable(),
      prepAhead: stepPrepAheadSchema.nullable(),
      ingredients: z.array(
        z.object({
          ingredient: candidateIngredientRefSchema,
          quantity: z.number().nullable(),
        }),
      ),
    }),
  ),
  tags: z.array(z.string()),
  estimates: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(['estimate', 'converted', 'nominal']),
    }),
  ),
  notes: z.array(z.string()),
});

export type RecipeImportCandidate = z.infer<typeof recipeImportCandidateSchema>;

// What a structured-output reader answers with: a candidate, the names of
// several recipes, or not a recipe.
export const recipeImportReadingSchema = z.union([
  z.object({
    outcome: z.literal('recipe'),
    recipe: recipeImportCandidateSchema,
  }),
  z.object({ outcome: z.literal('several'), names: z.array(z.string()) }),
  z.object({ outcome: z.literal('not_a_recipe') }),
]);

export type RecipeImportReading = z.infer<typeof recipeImportReadingSchema>;

// --- Proposal (written into the import draft as `fields.proposal`) ---------

const importKeySchema = z.string().trim().min(1).max(40);

export const recipeImportIngredientRefSchema = z.union([
  z.strictObject({ id: idSchema }),
  z.strictObject({ newKey: importKeySchema }),
]);

export type RecipeImportIngredientRef = z.infer<
  typeof recipeImportIngredientRefSchema
>;

export const recipeImportSourceRefSchema = z.union([
  z.strictObject({ id: idSchema }),
  z.strictObject({ newName: recipeSourceNameSchema }),
]);

export type RecipeImportSourceRef = z.infer<typeof recipeImportSourceRefSchema>;

// Paths: `header.<field>`, `ingredient:<key>.quantity`, `step:<key>.<field>`
// (DEC-108). `converted` and `nominal` mark ingredient quantities; every
// other mark is `estimate`.
export const RECIPE_IMPORT_ESTIMATE_PATH_PATTERN =
  /^(header\.[A-Za-z]+|ingredient:[^.\s]+\.quantity|step:[^.\s]+\.[A-Za-z]+)$/;

export const recipeImportEstimateSchema = z.object({
  path: z.string().max(100).regex(RECIPE_IMPORT_ESTIMATE_PATH_PATTERN),
  kind: z.enum(['estimate', 'converted', 'nominal']),
});

export type RecipeImportEstimate = z.infer<typeof recipeImportEstimateSchema>;

export const recipeImportProposedIngredientSchema = z.object({
  key: importKeySchema,
  name: ingredientNameSchema,
  // Null when the reader named a category or unit the household doesn't
  // have; the cook picks one in Import Review.
  categoryId: idSchema.nullable(),
  defaultUnitId: idSchema.nullable(),
  isPlant: z.boolean(),
  averageShelfLifeDays: ingredientShelfLifeSchema.nullable(),
});

export type RecipeImportProposedIngredient = z.infer<
  typeof recipeImportProposedIngredientSchema
>;

export const recipeImportProposalRowSchema = z.object({
  key: importKeySchema,
  ingredient: recipeImportIngredientRefSchema,
  // In the matched or proposed ingredient's one unit (DEC-18, DEC-105).
  quantity: recipeQuantitySchema,
  prepTypeId: idSchema.nullable(),
  isOptional: z.boolean(),
  originalLine: z
    .string()
    .trim()
    .min(1)
    .max(RECIPE_IMPORT_ORIGINAL_LINE_MAX_LENGTH),
});

export type RecipeImportProposalRow = z.infer<
  typeof recipeImportProposalRowSchema
>;

const stepLinksSchema = <T extends z.ZodType>(ingredient: T) =>
  z.array(
    z.object({ ingredient, quantity: recipeStepAmountSchema.nullable() }),
  );

export const recipeImportProposalStepSchema = z.object({
  key: importKeySchema,
  instruction: recipeInstructionSchema,
  safetyNote: recipeStepNoteSchema.nullable(),
  tip: recipeStepNoteSchema.nullable(),
  prepAhead: stepPrepAheadSchema.nullable(),
  ingredients: stepLinksSchema(recipeImportIngredientRefSchema),
});

export type RecipeImportProposalStep = z.infer<
  typeof recipeImportProposalStepSchema
>;

export const recipeImportProposalHeaderSchema = recipeHeaderWritableSchema
  .omit({
    sourceId: true,
    nutritionIsEstimated: true,
    estimatedCostPerServing: true,
    imageUrl: true,
  })
  .extend({
    // Never filled by a reader (DEC-106).
    estimatedCostPerServing: z.null(),
    imageUrl: z.null(),
  });

export type RecipeImportProposalHeader = z.infer<
  typeof recipeImportProposalHeaderSchema
>;

export const recipeImportProposalContentSchema = z.object({
  header: recipeImportProposalHeaderSchema,
  source: recipeImportSourceRefSchema.nullable(),
  newIngredients: z
    .array(recipeImportProposedIngredientSchema)
    .max(RECIPE_IMPORT_ROWS_MAX),
  ingredients: z
    .array(recipeImportProposalRowSchema)
    .max(RECIPE_IMPORT_ROWS_MAX),
  method: z.array(recipeImportProposalStepSchema).max(RECIPE_IMPORT_ROWS_MAX),
  // Existing household tags only (DEC-97, DEC-106).
  tags: z.array(recipeTagNameSchema).max(RECIPE_TAGS_MAX),
  estimates: z
    .array(recipeImportEstimateSchema)
    .max(RECIPE_IMPORT_ESTIMATES_MAX),
  // Shown in Import Review, never saved.
  notes: z
    .array(z.string().trim().min(1).max(RECIPE_IMPORT_NOTE_MAX_LENGTH))
    .max(RECIPE_IMPORT_NOTES_MAX),
});

export type RecipeImportProposalContent = z.infer<
  typeof recipeImportProposalContentSchema
>;

export const recipeImportReaderSchema = z.object({
  adapter: z.string().min(1),
  // The model that answered, which can differ from the one asked for when a
  // provider falls back after a refusal.
  model: z.string().min(1),
});

export type RecipeImportReader = z.infer<typeof recipeImportReaderSchema>;

export const recipeImportProposalSchema =
  recipeImportProposalContentSchema.extend({
    reader: recipeImportReaderSchema,
    input: recipeImportInputSchema,
  });

export type RecipeImportProposal = z.infer<typeof recipeImportProposalSchema>;

// --- List, get, discard -----------------------------------------------------

export const recipeImportDraftSummarySchema = z.object({
  id: draftIdSchema,
  // Null when the draft no longer holds a readable proposal.
  name: z.string().nullable(),
  inputKind: recipeImportInputKindSchema.nullable(),
  lastUpdatedAt: z.number().int().nonnegative(),
});

export type RecipeImportDraftSummary = z.infer<
  typeof recipeImportDraftSummarySchema
>;

export const listRecipeImportsResultSchema = z.array(
  recipeImportDraftSummarySchema,
);

export type ListRecipeImportsResult = z.infer<
  typeof listRecipeImportsResultSchema
>;

export const recipeImportDraftIdInputSchema = z.object({
  draftId: draftIdSchema,
});

export type RecipeImportDraftIdInput = z.infer<
  typeof recipeImportDraftIdInputSchema
>;

export const getRecipeImportResultSchema = z.object({
  id: draftIdSchema,
  proposal: recipeImportProposalSchema.nullable(),
  // An image import's images, in page order. Empty for any other input.
  images: z.array(recipeImageViewSchema),
  draftData: recipeDraftEnvelopeSchema,
  lastUpdatedAt: z.number().int().nonnegative(),
});

export type GetRecipeImportResult = z.infer<typeof getRecipeImportResultSchema>;

export const discardRecipeImportResultSchema = z.object({
  deleted: z.boolean(),
});

export type DiscardRecipeImportResult = z.infer<
  typeof discardRecipeImportResultSchema
>;

// --- Create recipe from an import -------------------------------------------

// An existing ingredient's row carries the unit the cook saw, so an
// ingredient whose unit changed since the import is caught (DEC-18).
const createLineIngredientSchema = z.union([
  z.strictObject({ id: idSchema, unitId: idSchema }),
  z.strictObject({ newKey: importKeySchema }),
]);

const createNewIngredientSchema = createIngredientInputSchema.extend({
  key: importKeySchema,
});

function refKey(ref: { id: number } | { newKey: string }): string {
  return 'id' in ref ? `id:${String(ref.id)}` : `new:${ref.newKey}`;
}

export const createRecipeFromImportInputSchema = z
  .object({
    draftId: draftIdSchema,
    header: recipeHeaderWritableSchema.omit({ sourceId: true }),
    source: recipeImportSourceRefSchema.nullable(),
    newIngredients: z
      .array(createNewIngredientSchema)
      .max(RECIPE_IMPORT_ROWS_MAX),
    lines: z
      .array(
        z.object({
          ingredient: createLineIngredientSchema,
          quantity: recipeQuantitySchema,
          prepTypeId: idSchema.nullable(),
          isOptional: z.boolean(),
        }),
      )
      .max(RECIPE_IMPORT_ROWS_MAX),
    steps: z
      .array(
        z.object({
          instruction: recipeInstructionSchema,
          safetyNote: recipeStepNoteSchema.nullable(),
          tip: recipeStepNoteSchema.nullable(),
          prepAhead: stepPrepAheadSchema.nullable(),
          ingredients: stepLinksSchema(recipeImportIngredientRefSchema)
            .max(50)
            .refine(
              (links) =>
                new Set(links.map((link) => refKey(link.ingredient))).size ===
                links.length,
              'Each ingredient can only be listed once per step',
            ),
        }),
      )
      .max(RECIPE_IMPORT_ROWS_MAX),
    tagNames: z.array(recipeTagNameSchema).max(RECIPE_TAGS_MAX),
  })
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    const names = new Set<string>();
    value.newIngredients.forEach((ingredient, index) => {
      if (keys.has(ingredient.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['newIngredients', index, 'key'],
          message: 'Each new ingredient needs its own key',
        });
      }
      keys.add(ingredient.key);
      const lower = ingredient.name.toLowerCase();
      if (names.has(lower)) {
        ctx.addIssue({
          code: 'custom',
          path: ['newIngredients', index, 'name'],
          message: 'Two new ingredients have the same name',
        });
      }
      names.add(lower);
    });
    const checkRef = (
      ref: { id: number } | { newKey: string },
      path: (string | number)[],
    ) => {
      if ('newKey' in ref && !keys.has(ref.newKey)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: 'Unknown new ingredient',
        });
      }
    };
    value.lines.forEach((line, index) => {
      checkRef(line.ingredient, ['lines', index, 'ingredient']);
    });
    value.steps.forEach((step, stepIndex) => {
      step.ingredients.forEach((link, linkIndex) => {
        checkRef(link.ingredient, [
          'steps',
          stepIndex,
          'ingredients',
          linkIndex,
          'ingredient',
        ]);
      });
    });
  });

export type CreateRecipeFromImportInput = z.infer<
  typeof createRecipeFromImportInputSchema
>;

export const createRecipeFromImportResultSchema = z.object({
  recipeId: idSchema,
});

export type CreateRecipeFromImportResult = z.infer<
  typeof createRecipeFromImportResultSchema
>;
