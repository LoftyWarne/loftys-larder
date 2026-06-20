import { Link, Outlet, redirect } from '@tanstack/react-router';
import { authClient } from '@/lib/auth-client.ts';

export async function authedBeforeLoad(): Promise<void> {
  const { data } = await authClient.getSession();
  if (!data) {
    throw redirect({ to: '/sign-in' });
  }
}

export function AuthedLayout(): React.ReactElement {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3 text-sm font-medium">
        <Link
          to="/"
          activeProps={{ className: 'text-primary' }}
          className="whitespace-nowrap hover:underline"
        >
          Home
        </Link>
        <Link
          to="/recipes"
          activeProps={{ className: 'text-primary' }}
          className="whitespace-nowrap hover:underline"
        >
          Recipes
        </Link>
        <Link
          to="/plans"
          activeProps={{ className: 'text-primary' }}
          className="whitespace-nowrap hover:underline"
        >
          Plans
        </Link>
        <Link
          to="/shopping"
          activeProps={{ className: 'text-primary' }}
          className="whitespace-nowrap hover:underline"
        >
          Shopping list
        </Link>
        <Link
          to="/ingredients"
          activeProps={{ className: 'text-primary' }}
          className="whitespace-nowrap hover:underline"
        >
          Ingredients
        </Link>
        <Link
          to="/settings"
          activeProps={{ className: 'text-primary' }}
          className="whitespace-nowrap hover:underline"
        >
          Settings
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
