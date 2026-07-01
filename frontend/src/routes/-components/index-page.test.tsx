import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { todayInLondon } from '@/lib/date-utils.ts';

vi.mock('@tanstack/react-router', () => ({
  // Render a real anchor with an href so the element carries the implicit
  // `link` role and exposes the route target for deep-link assertions.
  Link: (props: {
    children: React.ReactNode;
    to?: string;
  }): React.ReactElement => <a href={props.to ?? '#'}>{props.children}</a>,
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    user: { getMe: { useQuery: vi.fn() } },
    plans: { list: { useQuery: vi.fn() }, get: { useQuery: vi.fn() } },
  },
}));

import { trpc } from '@/lib/trpc.ts';
import { IndexPage } from './index-page.tsx';

const getMeMock = trpc.user.getMe.useQuery as unknown as ReturnType<
  typeof vi.fn
>;
const listMock = trpc.plans.list.useQuery as unknown as ReturnType<
  typeof vi.fn
>;
const getPlanMock = trpc.plans.get.useQuery as unknown as ReturnType<
  typeof vi.fn
>;

const TODAY = todayInLondon();

function stubMe(): void {
  getMeMock.mockReturnValue({ data: { name: 'Conor' } });
}

beforeEach(() => {
  getMeMock.mockReset();
  listMock.mockReset();
  getPlanMock.mockReset();
  // Sensible defaults; individual tests override what they exercise.
  stubMe();
  getPlanMock.mockReturnValue({ data: undefined, isLoading: false });
});

describe('IndexPage', () => {
  it('greets the user by name and time of day', () => {
    listMock.mockReturnValue({ data: { items: [] }, isLoading: false });
    render(<IndexPage />);
    expect(
      screen.getByRole('heading', { name: /, Conor$/ }),
    ).toBeInTheDocument();
  });

  it('shows the empty state with a New plan CTA when there is no active plan', () => {
    listMock.mockReturnValue({ data: { items: [] }, isLoading: false });
    render(<IndexPage />);
    expect(screen.getByText(/no active plan/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /new plan/i })).toBeInTheDocument();
  });

  it('lists today’s meals with live recipes linking to their detail page', () => {
    listMock.mockReturnValue({
      data: {
        items: [
          {
            id: 7,
            startDate: '2026-06-22',
            endDate: '2026-06-28',
            createdByUserId: null,
            slotsTotal: 14,
            slotsAssigned: 9,
          },
        ],
      },
      isLoading: false,
    });
    getPlanMock.mockReturnValue({
      isLoading: false,
      data: {
        id: 7,
        startDate: '2026-06-22',
        endDate: '2026-06-28',
        createdByUserId: null,
        slots: [
          slot({ id: 1, occasionId: 2, occasionName: 'Dinner' }, 'Thai curry'),
          slot({ id: 2, occasionId: 1, occasionName: 'Breakfast' }, 'Porridge'),
          emptySlot({ id: 3, occasionId: 3, occasionName: 'Lunch' }),
          // a recipe soft-deleted after assignment
          slot(
            { id: 4, occasionId: 4, occasionName: 'Supper' },
            'Old stew',
            true,
          ),
        ],
      },
    });

    render(<IndexPage />);

    expect(screen.getByText('— not planned —')).toBeInTheDocument();
    // Live recipes link to their detail page.
    const curryLink = screen.getByRole('link', { name: 'Thai curry' });
    expect(curryLink).toHaveAttribute('href', '/recipes/$recipeId');
    expect(screen.getByRole('link', { name: 'Porridge' })).toBeInTheDocument();
    // A soft-deleted recipe renders, tagged, but is not a link.
    expect(screen.getByText('Old stew (deleted)')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /old stew/i }),
    ).not.toBeInTheDocument();
    // Open planner deep-links to the active plan.
    expect(screen.getByRole('link', { name: /open planner/i })).toHaveAttribute(
      'href',
      '/plans/$planId',
    );
  });

  it('lists remaining days under “Coming up”, planned meals only', () => {
    const tomorrow = addDays(TODAY, 1);
    const dayAfter = addDays(TODAY, 2);
    listMock.mockReturnValue({
      data: {
        items: [
          {
            id: 7,
            startDate: TODAY,
            endDate: dayAfter,
            createdByUserId: null,
            slotsTotal: 6,
            slotsAssigned: 2,
          },
        ],
      },
      isLoading: false,
    });
    getPlanMock.mockReturnValue({
      isLoading: false,
      data: {
        id: 7,
        startDate: TODAY,
        endDate: dayAfter,
        createdByUserId: null,
        slots: [
          slot({ id: 1, occasionId: 2, occasionName: 'Dinner' }, 'Thai curry'),
          slot(
            { id: 2, occasionId: 2, occasionName: 'Dinner', date: tomorrow },
            'Lasagne',
          ),
          // tomorrow's empty occasion — should be filtered out of Coming up
          emptySlot({
            id: 3,
            occasionId: 1,
            occasionName: 'Breakfast',
            date: tomorrow,
          }),
          // a day with nothing planned at all
          emptySlot({
            id: 4,
            occasionId: 2,
            occasionName: 'Dinner',
            date: dayAfter,
          }),
        ],
      },
    });

    render(<IndexPage />);

    expect(screen.getByText('Coming up')).toBeInTheDocument();
    // Tomorrow's planned dinner is shown and clickable.
    expect(screen.getByRole('link', { name: 'Lasagne' })).toBeInTheDocument();
    // Tomorrow's empty breakfast is omitted from Coming up entirely.
    expect(screen.queryByText('Breakfast')).not.toBeInTheDocument();
    // The fully-empty day still appears, marked unplanned.
    expect(screen.getByText('— not planned —')).toBeInTheDocument();
  });

  it('shows a loading state while the active plan resolves', () => {
    listMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<IndexPage />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error alert when the active plan query fails', () => {
    listMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: 'boom' },
    });
    render(<IndexPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});

interface SlotOpts {
  id: number;
  occasionId: number;
  occasionName: string;
  date?: string;
}

function baseSlot(opts: SlotOpts): Record<string, unknown> {
  return {
    id: opts.id,
    planId: 7,
    date: opts.date ?? TODAY,
    occasionId: opts.occasionId,
    occasionName: opts.occasionName,
    chefUserId: null,
    comment: null,
    items: [],
  };
}

function slot(
  opts: SlotOpts,
  recipeName: string,
  isDeleted = false,
): Record<string, unknown> {
  return {
    ...baseSlot(opts),
    slotType: 'recipe',
    items: [
      {
        id: opts.id * 100,
        recipeId: opts.id * 10,
        recipeName,
        recipeImageUrl: null,
        isBase: false,
        baseRecipeId: null,
        isDeleted,
        prepared: 2,
        eaten: 2,
        sortOrder: 0,
      },
    ],
  };
}

function emptySlot(opts: SlotOpts): Record<string, unknown> {
  return { ...baseSlot(opts), slotType: 'empty' };
}

// Advance a YYYY-MM-DD civil date by N days via UTC arithmetic.
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(
    Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) + days * 86_400_000,
  );
  const yy = String(next.getUTCFullYear()).padStart(4, '0');
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
