import { createFileRoute } from '@tanstack/react-router';
import { ShoppingIndexPage } from '../-components/shopping-index-page.tsx';

export const Route = createFileRoute('/_authed/shopping')({
  component: ShoppingIndexPage,
});
