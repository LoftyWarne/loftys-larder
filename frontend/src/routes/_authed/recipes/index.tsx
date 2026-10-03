import { recipeListSearchSchema } from '@loftys-larder/shared';
import { createFileRoute } from '@tanstack/react-router';
import { RecipesPage } from '../../-components/recipes-page.tsx';

export const Route = createFileRoute('/_authed/recipes/')({
  validateSearch: recipeListSearchSchema,
  component: RecipesPage,
});
