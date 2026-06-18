import { createFileRoute } from '@tanstack/react-router';
import {
  SignInPage,
  signInBeforeLoad,
  signInSearchSchema,
} from './-components/sign-in-page.tsx';

export const Route = createFileRoute('/sign-in')({
  validateSearch: signInSearchSchema,
  beforeLoad: signInBeforeLoad,
  component: SignInRoute,
});

function SignInRoute(): React.ReactElement {
  const { deleted } = Route.useSearch();
  return <SignInPage justDeleted={deleted === '1'} />;
}
