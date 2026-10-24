import { cookSearchSchema } from '@loftys-larder/shared';
import { createFileRoute } from '@tanstack/react-router';
import { CookModePage } from '../../-components/cook-mode-page.tsx';

export const Route = createFileRoute('/_authed/recipes/$recipeId/cook')({
  validateSearch: cookSearchSchema,
  component: CookModePage,
});
