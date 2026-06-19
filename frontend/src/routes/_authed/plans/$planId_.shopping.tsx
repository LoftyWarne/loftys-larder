import { createFileRoute } from '@tanstack/react-router';

import { ShoppingListPage } from '../../-components/shopping-list-page.tsx';

// Thin route shell — page body lives under `-components/` per the AGENTS.md
// trap (auto-code-split only splits `Route.options.component`).
export const Route = createFileRoute('/_authed/plans/$planId_/shopping')({
  component: ShoppingListPage,
});
