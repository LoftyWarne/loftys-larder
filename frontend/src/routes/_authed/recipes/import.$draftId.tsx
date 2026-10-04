import { createFileRoute } from '@tanstack/react-router';
import { RecipeImportReviewPage } from '../../-components/recipe-import-review-page.tsx';

export const Route = createFileRoute('/_authed/recipes/import/$draftId')({
  component: RecipeImportReviewPage,
});
