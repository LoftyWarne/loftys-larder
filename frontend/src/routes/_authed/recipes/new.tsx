import { createFileRoute } from '@tanstack/react-router';
import { RecipeNewPage } from '../../-components/recipe-new-page.tsx';

export const Route = createFileRoute('/_authed/recipes/new')({
  component: RecipeNewPage,
});
