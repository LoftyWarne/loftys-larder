import { createFileRoute } from '@tanstack/react-router';
import { SignInPage, signInBeforeLoad } from './-components/sign-in-page.tsx';

export const Route = createFileRoute('/sign-in')({
  beforeLoad: signInBeforeLoad,
  component: SignInPage,
});
