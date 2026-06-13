import { z } from 'zod';

// Server-side autosave for the recipe editor. The server only enforces the
// envelope — `version` (so future shape changes are detectable and old drafts
// can be dropped) and the `fields` bag. The editor owns the shape of `fields`
// and robust-parses on load; coupling the server schema to the editor's field
// set would mean every editor change forces a backend deploy.

const recipeIdSchema = z.number().int().positive();

export const RECIPE_DRAFT_VERSION = 1;

export const recipeDraftEnvelopeSchema = z.object({
  version: z.literal(RECIPE_DRAFT_VERSION),
  fields: z.record(z.string(), z.unknown()),
});

export type RecipeDraftEnvelope = z.infer<typeof recipeDraftEnvelopeSchema>;

export const upsertRecipeDraftInputSchema = z.object({
  // When `draftId` is provided, the row with that id is updated in place
  // (after an ownership check). This is how new-recipe drafts (recipe_id IS
  // NULL) stay attached to a single row across many autosaves — without it,
  // the NULL-distinct unique index would create a new row per keystroke.
  // Existing-recipe drafts can omit `draftId` and rely on the ON CONFLICT
  // upsert keyed by `(user_id, recipe_id)`.
  draftId: z.number().int().positive().optional(),
  recipeId: recipeIdSchema.nullable(),
  draftData: recipeDraftEnvelopeSchema,
});

export type UpsertRecipeDraftInput = z.infer<
  typeof upsertRecipeDraftInputSchema
>;

export const upsertRecipeDraftResultSchema = z.object({
  id: z.number().int().positive(),
  lastUpdatedAt: z.number().int().nonnegative(),
});

export type UpsertRecipeDraftResult = z.infer<
  typeof upsertRecipeDraftResultSchema
>;

export const getRecipeDraftForRecipeInputSchema = z.object({
  recipeId: recipeIdSchema,
});

export type GetRecipeDraftForRecipeInput = z.infer<
  typeof getRecipeDraftForRecipeInputSchema
>;

export const recipeDraftSchema = z.object({
  id: z.number().int().positive(),
  draftData: recipeDraftEnvelopeSchema,
  lastUpdatedAt: z.number().int().nonnegative(),
});

export type RecipeDraft = z.infer<typeof recipeDraftSchema>;

export const getRecipeDraftForRecipeResultSchema = recipeDraftSchema.nullable();

export type GetRecipeDraftForRecipeResult = z.infer<
  typeof getRecipeDraftForRecipeResultSchema
>;

export const getNewRecipeDraftsResultSchema = z.array(recipeDraftSchema);

export type GetNewRecipeDraftsResult = z.infer<
  typeof getNewRecipeDraftsResultSchema
>;

export const deleteRecipeDraftInputSchema = z.object({
  recipeId: recipeIdSchema.nullable(),
});

export type DeleteRecipeDraftInput = z.infer<
  typeof deleteRecipeDraftInputSchema
>;

export const deleteRecipeDraftResultSchema = z.object({
  deleted: z.boolean(),
});

export type DeleteRecipeDraftResult = z.infer<
  typeof deleteRecipeDraftResultSchema
>;
