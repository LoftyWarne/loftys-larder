import type { PlanListItem } from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { navigateMock, listUseQueryMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  listUseQueryMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    plans: { list: { useQuery: listUseQueryMock } },
  },
}));

// Pin "today" so the horizon maths is deterministic; keep the real
// `addCivilDays` so the ±2-day window is exercised, not stubbed.
vi.mock('@/lib/date-utils.ts', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/date-utils.ts')>()),
  todayInLondon: () => '2026-07-12',
}));

import { ShoppingIndexPage } from './shopping-index-page.tsx';

function plan(id: number, startDate: string, endDate: string): PlanListItem {
  return {
    id,
    startDate,
    endDate,
    createdByUserId: null,
    slotsTotal: 7,
    slotsAssigned: 7,
  };
}

interface SetupOptions {
  active?: PlanListItem[];
  future?: PlanListItem[];
  isLoading?: boolean;
  error?: { message: string } | null;
}

function setup(options: SetupOptions = {}): void {
  listUseQueryMock.mockImplementation((input: { status: string }) => ({
    data: {
      items:
        input.status === 'active'
          ? (options.active ?? [])
          : (options.future ?? []),
    },
    isLoading: options.isLoading ?? false,
    error: options.error ?? null,
  }));
}

beforeEach(() => {
  navigateMock.mockReset();
  listUseQueryMock.mockReset();
});

async function expectRedirectTo(planId: string): Promise<void> {
  await waitFor(() => {
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/plans/$planId/shopping',
      params: { planId },
      replace: true,
    });
  });
}

describe('ShoppingIndexPage', () => {
  it('on the eve, defaults to the plan starting tomorrow over the active plan', async () => {
    // Active plan ends today; a new plan begins tomorrow — shop for tomorrow's.
    setup({
      active: [plan(1, '2026-07-06', '2026-07-12')],
      future: [plan(2, '2026-07-13', '2026-07-19')],
    });
    render(<ShoppingIndexPage />);
    await expectRedirectTo('2');
  });

  it('treats a plan starting within the 2-day horizon as imminent', async () => {
    setup({
      active: [plan(1, '2026-07-06', '2026-07-12')],
      future: [plan(2, '2026-07-14', '2026-07-20')],
    });
    render(<ShoppingIndexPage />);
    await expectRedirectTo('2');
  });

  it('mid-week, keeps the active plan when the next plan is beyond the horizon', async () => {
    setup({
      active: [plan(1, '2026-07-08', '2026-07-14')],
      future: [plan(2, '2026-07-20', '2026-07-26')],
    });
    render(<ShoppingIndexPage />);
    await expectRedirectTo('1');
  });

  it('picks the soonest imminent plan when several are upcoming', async () => {
    setup({
      active: [plan(1, '2026-07-06', '2026-07-12')],
      future: [
        plan(3, '2026-07-20', '2026-07-26'),
        plan(2, '2026-07-13', '2026-07-19'),
      ],
    });
    render(<ShoppingIndexPage />);
    await expectRedirectTo('2');
  });

  it('falls back to the active plan when there is no upcoming plan', async () => {
    setup({ active: [plan(1, '2026-07-08', '2026-07-14')], future: [] });
    render(<ShoppingIndexPage />);
    await expectRedirectTo('1');
  });

  it('uses a future plan beyond the horizon when no plan is active', async () => {
    setup({ active: [], future: [plan(2, '2026-07-20', '2026-07-26')] });
    render(<ShoppingIndexPage />);
    await expectRedirectTo('2');
  });

  it('shows an empty state when no active or upcoming plan exists', () => {
    setup({ active: [], future: [] });
    render(<ShoppingIndexPage />);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/no current or upcoming plan/i),
    ).toBeInTheDocument();
  });

  it('renders the loading state while the queries resolve', () => {
    setup({ isLoading: true });
    render(<ShoppingIndexPage />);
    expect(screen.getByRole('status')).toHaveTextContent(
      /loading shopping list/i,
    );
  });

  it('renders the error message when a query fails', () => {
    setup({ error: { message: 'boom' } });
    render(<ShoppingIndexPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});
