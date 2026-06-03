import { createFileRoute } from '@tanstack/react-router';
import {
  AuthedLayout,
  authedBeforeLoad,
} from './-components/authed-layout.tsx';

export const Route = createFileRoute('/_authed')({
  beforeLoad: authedBeforeLoad,
  component: AuthedLayout,
});
