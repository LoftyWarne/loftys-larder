import { createFileRoute } from '@tanstack/react-router';

import { PlanWizardPage } from '../../-components/plan-wizard-page.tsx';

// Route shell for the planning wizard (DEC-117). The step lives in React
// state, not the URL. Nothing links here yet: the plans page's entry comes
// with batch cooking.
export const Route = createFileRoute('/_authed/plans/propose')({
  component: PlanWizardPage,
});
