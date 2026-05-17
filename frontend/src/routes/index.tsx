import { createFileRoute } from '@tanstack/react-router';
import { IndexPage } from './-components/index-page.tsx';

export const Route = createFileRoute('/')({
  component: IndexPage,
});
