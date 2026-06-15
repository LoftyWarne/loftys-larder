import { plannerSearchSchema } from '@loftys-larder/shared';
import { createFileRoute } from '@tanstack/react-router';

import { PlannerPage } from '../../-components/planner-page.tsx';

// FEAT-31 — route shell. Search-param validation lives here; the page body
// and any future `beforeLoad` belong under `-components/` (AGENTS.md trap:
// route files export only `Route`).
export const Route = createFileRoute('/_authed/plans/$planId')({
  validateSearch: plannerSearchSchema,
  component: PlannerPage,
});
