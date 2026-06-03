import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { authClient } from '@/lib/auth-client.ts';

export async function authedBeforeLoad(): Promise<void> {
  const { data } = await authClient.getSession();
  if (!data) {
    throw redirect({ to: '/sign-in' });
  }
}

export const Route = createFileRoute('/_authed')({
  beforeLoad: authedBeforeLoad,
  component: AuthedLayout,
});

function AuthedLayout(): React.ReactElement {
  return <Outlet />;
}
