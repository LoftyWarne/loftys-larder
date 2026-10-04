import { createFileRoute } from '@tanstack/react-router';
import { RecipeImportPage } from '../../-components/recipe-import-page.tsx';

export const Route = createFileRoute('/_authed/recipes/import/')({
  component: RecipeImportPage,
});
