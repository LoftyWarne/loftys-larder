import { createFileRoute } from '@tanstack/react-router';
import { IngredientsPage } from '../-components/ingredients-page.tsx';

export const Route = createFileRoute('/_authed/ingredients')({
  component: IngredientsPage,
});
