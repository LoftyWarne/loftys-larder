import { createFileRoute } from '@tanstack/react-router';
import { WelcomePage, welcomeBeforeLoad } from './-components/welcome-page.tsx';

export const Route = createFileRoute('/welcome')({
  beforeLoad: welcomeBeforeLoad,
  component: WelcomePage,
});
