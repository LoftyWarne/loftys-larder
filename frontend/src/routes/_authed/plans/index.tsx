import { plansSearchSchema } from '@loftys-larder/shared';
import { createFileRoute } from '@tanstack/react-router';

import { PlansPage } from '../../-components/plans-page.tsx';

// Route shell. `validateSearch` parses `?status=` so the page body can
// rely on the typed search value (default: 'active'). Page body and any
// future `beforeLoad` belong under `-components/`.
export const Route = createFileRoute('/_authed/plans/')({
  validateSearch: plansSearchSchema,
  component: PlansPage,
});
