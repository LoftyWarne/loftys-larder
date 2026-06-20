import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-client.ts', () => ({
  authClient: {
    getSession: vi.fn(),
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    createFileRoute: () => (config: unknown) => config,
    // Replace Link with a plain anchor so the layout can render outside a
    // Router context. We don't need active-state behaviour for these tests.
    Link: ({
      to,
      children,
      ...rest
    }: {
      to: string;
      children: React.ReactNode;
      activeProps?: unknown;
      inactiveProps?: unknown;
      [key: string]: unknown;
    }) => {
      // Drop activeProps/inactiveProps so they don't end up as DOM
      // attributes.
      delete rest.activeProps;
      delete rest.inactiveProps;
      return (
        <a href={to} {...(rest as Record<string, unknown>)}>
          {children}
        </a>
      );
    },
    Outlet: () => <div data-testid="outlet" />,
  };
});

import { authClient } from '@/lib/auth-client.ts';
import { AuthedLayout, authedBeforeLoad } from './authed-layout.tsx';

const getSessionMock = authClient.getSession as unknown as ReturnType<
  typeof vi.fn
>;

const noop = (): void => undefined;
function mockIsLargeViewport(isLarge: boolean): void {
  window.matchMedia = (query: string): MediaQueryList => {
    const mql: Partial<MediaQueryList> = {
      matches: query === '(min-width: 64rem)' ? isLarge : false,
      media: query,
      onchange: null,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
    };
    return mql as MediaQueryList;
  };
}

beforeEach(() => {
  getSessionMock.mockReset();
});

describe('authedBeforeLoad', () => {
  it('throws a redirect to /sign-in when there is no session', async () => {
    getSessionMock.mockResolvedValue({ data: null });
    await expect(authedBeforeLoad()).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
  });

  it('does nothing when a session is present', async () => {
    getSessionMock.mockResolvedValue({ data: { user: { id: 'u1' } } });
    await expect(authedBeforeLoad()).resolves.toBeUndefined();
  });
});

describe('AuthedLayout', () => {
  it('renders the top-row nav with all six destinations at lg+', () => {
    mockIsLargeViewport(true);
    render(<AuthedLayout />);

    // Bottom tab bar is absent on the desktop shape.
    expect(
      screen.queryByRole('navigation', { name: /primary/i }),
    ).not.toBeInTheDocument();

    // All six destinations are present as plain text links.
    for (const label of [
      'Home',
      'Recipes',
      'Plans',
      'Shopping list',
      'Ingredients',
      'Settings',
    ]) {
      expect(
        screen.getByRole('link', { name: new RegExp(`^${label}$`, 'i') }),
      ).toBeInTheDocument();
    }
  });

  it('renders a header + bottom tab bar with four primary destinations on phone', () => {
    mockIsLargeViewport(false);
    render(<AuthedLayout />);

    // App title links Home; Settings is a gear icon-only link.
    expect(
      screen.getByRole('link', { name: /lofty's larder/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /^settings$/i }),
    ).toBeInTheDocument();

    // Bottom nav with four primary tabs.
    const bottomNav = screen.getByRole('navigation', { name: /primary/i });
    expect(bottomNav).toBeInTheDocument();
    for (const label of ['Plans', 'Shopping list', 'Recipes', 'Ingredients']) {
      // The label appears in the tab bar; bottom nav contains it.
      expect(
        bottomNav.querySelector(`a[href="/${labelToPath(label)}"]`),
      ).not.toBeNull();
    }
  });
});

function labelToPath(label: string): string {
  switch (label) {
    case 'Plans':
      return 'plans';
    case 'Shopping list':
      return 'shopping';
    case 'Recipes':
      return 'recipes';
    case 'Ingredients':
      return 'ingredients';
    default:
      throw new Error(`unknown label: ${label}`);
  }
}
