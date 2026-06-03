import { createFileRoute } from '@tanstack/react-router';
import {
  VerifyView,
  verifyBeforeLoad,
  verifySearchSchema,
} from './-components/verify-page.tsx';

export const Route = createFileRoute('/auth/verify')({
  validateSearch: verifySearchSchema,
  beforeLoad: verifyBeforeLoad,
  component: VerifyPage,
});

function VerifyPage(): React.ReactElement {
  const { error } = Route.useSearch();
  return <VerifyView error={error} />;
}
