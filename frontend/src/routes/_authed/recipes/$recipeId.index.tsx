import { createFileRoute } from '@tanstack/react-router';
import { RecipeDetailPage } from '../../-components/recipe-detail-page.tsx';

export const Route = createFileRoute('/_authed/recipes/$recipeId/')({
  component: RecipeDetailPage,
});
