import { z } from 'zod';

import { recipeHealthScoreDetailSchema } from './recipes.ts';

// Health scoring (DEC-112): a model reads a recipe and returns a Health Score
// from 1 to 10, a summary and at most one Suggestion.

const recipeIdSchema = z.number().int().positive();

export const HEALTH_SCORE_SUMMARY_MAX_LENGTH = 300;
export const HEALTH_SCORE_SUGGESTION_MAX_LENGTH = 200;

export const healthScoreRecipeKindSchema = z.enum([
  'standalone',
  'base',
  'variation',
]);

export type HealthScoreRecipeKind = z.infer<typeof healthScoreRecipeKindSchema>;

export const healthScoreLineSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  prepType: z.string().nullable(),
  isOptional: z.boolean(),
});

export type HealthScoreLine = z.infer<typeof healthScoreLineSchema>;

export const healthScoreNutritionSchema = z.object({
  caloriesPerServing: z.number().nullable(),
  fatPerServing: z.number().nullable(),
  saturatedFatPerServing: z.number().nullable(),
  carbsPerServing: z.number().nullable(),
  sugarPerServing: z.number().nullable(),
  fibrePerServing: z.number().nullable(),
  proteinPerServing: z.number().nullable(),
  saltPerServing: z.number().nullable(),
});

// What the scorer is sent, and all it's sent (DEC-112). Quantities are for the
// whole recipe and are numbers, so two requests compare with a deep equal.
// `base` is set only for a serving variation, which is eaten as one base
// serving per serving.
export const healthScoreRequestSchema = z.object({
  recipe: z.object({
    name: z.string(),
    kind: healthScoreRecipeKindSchema,
    baseServings: z.number().int().positive(),
    lines: z.array(healthScoreLineSchema),
    steps: z.array(z.string()),
    nutrition: healthScoreNutritionSchema,
    nutritionIsEstimated: z.boolean(),
  }),
  base: z
    .object({
      baseServings: z.number().int().positive(),
      lines: z.array(healthScoreLineSchema),
      steps: z.array(z.string()),
    })
    .nullable(),
});

export type HealthScoreRequest = z.infer<typeof healthScoreRequestSchema>;

// The scorer's reply, kept to what structured outputs can express: no range
// or length limits. `normaliseHealthScore` parses it into the result.
export const healthScoreCandidateSchema = z.object({
  score: z.number().describe('The Health Score, a whole number from 1 to 10.'),
  summary: z
    .string()
    .describe('What raises and lowers the score, in plain text.'),
  suggestion: z
    .string()
    .nullable()
    .describe('One change that would raise the score, or null.'),
});

export type HealthScoreCandidate = z.infer<typeof healthScoreCandidateSchema>;

export const healthScoreResultSchema = z.object({
  score: z.number().int().min(1).max(10),
  summary: z.string().min(1).max(HEALTH_SCORE_SUMMARY_MAX_LENGTH),
  suggestion: z
    .string()
    .min(1)
    .max(HEALTH_SCORE_SUGGESTION_MAX_LENGTH)
    .nullable(),
});

export type HealthScoreResult = z.infer<typeof healthScoreResultSchema>;

export const scoreRecipeHealthInputSchema = z.object({
  recipeId: recipeIdSchema,
  // Score even when the score is current.
  rescore: z.boolean(),
});

export type ScoreRecipeHealthInput = z.infer<
  typeof scoreRecipeHealthInputSchema
>;

// `scored`: a score was written. `current`: the score was current and this
// wasn't a rescore. `changed`: the recipe changed while it was being scored,
// so nothing was written. `nothing_to_score`: no ingredient lines.
// `deleted`: the recipe is soft-deleted. Only `scored` and `changed` called
// the model.
export const HEALTH_SCORE_OUTCOMES = [
  'scored',
  'current',
  'changed',
  'nothing_to_score',
  'deleted',
] as const;

export const healthScoreOutcomeSchema = z.enum(HEALTH_SCORE_OUTCOMES);

export type HealthScoreOutcome = z.infer<typeof healthScoreOutcomeSchema>;

export const scoreRecipeHealthResultSchema = z.object({
  outcome: healthScoreOutcomeSchema,
  // The recipe's score after the call, which may be none.
  healthScore: recipeHealthScoreDetailSchema.nullable(),
});

export type ScoreRecipeHealthResult = z.infer<
  typeof scoreRecipeHealthResultSchema
>;

// With a recipe id: that recipe and, for a base, its serving variations.
// Without: every recipe in the household.
export const healthScoresDueInputSchema = z.object({
  recipeId: recipeIdSchema.optional(),
});

export type HealthScoresDueInput = z.infer<typeof healthScoresDueInputSchema>;

// `older_scorer`: scored before `HEALTH_SCORE_SINCE`, the date the scoring
// model or prompt last changed.
export const healthScoreDueReasonSchema = z.enum([
  'not_scored',
  'out_of_date',
  'older_scorer',
]);

export type HealthScoreDueReason = z.infer<typeof healthScoreDueReasonSchema>;

export const healthScoresDueResultSchema = z.object({
  recipes: z.array(
    z.object({
      recipeId: recipeIdSchema,
      reason: healthScoreDueReasonSchema,
    }),
  ),
});

export type HealthScoresDueResult = z.infer<typeof healthScoresDueResultSchema>;
