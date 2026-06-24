import { Link, Outlet, redirect } from '@tanstack/react-router';
import {
  BookOpen,
  CalendarDays,
  Carrot,
  Home,
  Settings as SettingsIcon,
  ShoppingBasket,
  type LucideIcon,
} from 'lucide-react';

import { useIsLargeViewport } from '@/hooks/use-is-large-viewport.ts';
import { authClient } from '@/lib/auth-client.ts';
import { cn } from '@/lib/utils.ts';

export async function authedBeforeLoad(): Promise<void> {
  const { data } = await authClient.getSession();
  if (!data) {
    throw redirect({ to: '/sign-in' });
  }
  // New magic-link users are created with an empty name. Gate the app behind
  // the onboarding step until they've chosen one.
  if (data.user.name.trim() === '') {
    throw redirect({ to: '/welcome' });
  }
}

interface NavItem {
  to: '/' | '/recipes' | '/plans' | '/shopping' | '/ingredients' | '/settings';
  label: string;
  Icon: LucideIcon;
}

// The primary destinations live under the thumb on phones (bottom tab bar)
// and across the top on desktop. Home and Settings are de-emphasised on
// phones — Home is the app-title link, Settings is a gear icon — so they
// stay out of the four-tab bar.
const PRIMARY_NAV: NavItem[] = [
  { to: '/plans', label: 'Plans', Icon: CalendarDays },
  { to: '/shopping', label: 'Shopping list', Icon: ShoppingBasket },
  { to: '/recipes', label: 'Recipes', Icon: BookOpen },
  { to: '/ingredients', label: 'Ingredients', Icon: Carrot },
];

const ALL_NAV: NavItem[] = [
  { to: '/', label: 'Home', Icon: Home },
  ...PRIMARY_NAV,
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
];

export function AuthedLayout(): React.ReactElement {
  const isLargeViewport = useIsLargeViewport();
  if (isLargeViewport) {
    return <DesktopShell />;
  }
  return <PhoneShell />;
}

function DesktopShell(): React.ReactElement {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3 text-sm font-medium">
        {ALL_NAV.map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            activeProps={{ className: 'text-primary' }}
            className="whitespace-nowrap hover:underline"
          >
            {label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

function PhoneShell(): React.ReactElement {
  return (
    <div className="space-y-4 pb-20">
      <header className="sticky top-0 z-10 -mx-3 flex items-center justify-between border-b bg-background px-3 py-2">
        <Link
          to="/"
          activeProps={{ className: 'text-primary' }}
          className="text-base font-semibold hover:underline"
        >
          Lofty&apos;s Larder
        </Link>
        <Link
          to="/settings"
          aria-label="Settings"
          activeProps={{ className: 'text-primary' }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <SettingsIcon className="h-5 w-5" aria-hidden="true" />
        </Link>
      </header>
      <Outlet />
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-4 border-t bg-background pb-[env(safe-area-inset-bottom)]"
      >
        {PRIMARY_NAV.map(({ to, label, Icon }) => (
          <Link
            key={to}
            to={to}
            activeProps={{
              className: 'text-primary border-primary',
            }}
            inactiveProps={{
              className: 'text-muted-foreground border-transparent',
            }}
            className={cn(
              'flex flex-col items-center justify-center gap-0.5 border-t-2 px-1 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-ring',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
