import { z } from 'zod';

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
