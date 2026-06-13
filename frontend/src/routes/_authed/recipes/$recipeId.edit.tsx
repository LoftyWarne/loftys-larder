import { createFileRoute } from '@tanstack/react-router';
import { RecipeEditPage } from '../../-components/recipe-edit-page.tsx';

export const Route = createFileRoute('/_authed/recipes/$recipeId/edit')({
  component: RecipeEditPage,
});
