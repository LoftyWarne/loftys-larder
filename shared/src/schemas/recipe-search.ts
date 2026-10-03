import { z } from 'zod';

import {
  RECIPE_FILTER_INGREDIENTS_MAX,
  RECIPE_FILTER_SOURCES_MAX,
  RECIPE_TAGS_MAX,
  recipeTimeLimitSchema,
} from './recipes.ts';

// URL search-param schema for the recipe detail page (DEC-98). `servings` is
// the number of portions to show amounts for; absent means the recipe's own
// `baseServings`. A malformed or out-of-range value is dropped rather than
// failing the route, so an old or hand-edited link still opens the recipe.
export const RECIPE_VIEW_SERVINGS_MAX = 50;

export const recipeSearchSchema = z.object({
  servings: z
    .number()
    .int()
    .min(1)
    .max(RECIPE_VIEW_SERVINGS_MAX)
    .optional()
    .catch(undefined),
});
export type RecipeSearch = z.infer<typeof recipeSearchSchema>;

function idListParam(max: number) {
  return z
    .array(z.number().int().positive())
    .min(1)
    .max(max)
    .optional()
    .catch(undefined);
}

// URL search-param schema for the recipes page (DEC-100): the name search and
// the filters, so they survive opening a recipe and pressing Back. As above,
// a bad value is dropped rather than failing the route.
export const recipeListSearchSchema = z.object({
  q: z.string().trim().min(1).max(120).optional().catch(undefined),
  tags: idListParam(RECIPE_TAGS_MAX),
  sources: idListParam(RECIPE_FILTER_SOURCES_MAX),
  ingredients: idListParam(RECIPE_FILTER_INGREDIENTS_MAX),
  maxTotal: recipeTimeLimitSchema.optional().catch(undefined),
  maxActive: recipeTimeLimitSchema.optional().catch(undefined),
});
export type RecipeListSearch = z.infer<typeof recipeListSearchSchema>;
