import { createFileRoute } from '@tanstack/react-router';
import { RecipesPage } from '../../-components/recipes-page.tsx';

export const Route = createFileRoute('/_authed/recipes/')({
  component: RecipesPage,
});
