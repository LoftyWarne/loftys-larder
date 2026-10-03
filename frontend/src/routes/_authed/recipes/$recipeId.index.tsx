import { recipeSearchSchema } from '@loftys-larder/shared';
import { createFileRoute } from '@tanstack/react-router';
import { RecipeDetailPage } from '../../-components/recipe-detail-page.tsx';

export const Route = createFileRoute('/_authed/recipes/$recipeId/')({
  validateSearch: recipeSearchSchema,
  component: RecipeDetailPage,
});
