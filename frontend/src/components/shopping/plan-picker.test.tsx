import type { PlanListItem } from '@loftys-larder/shared';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listUseQueryMock } = vi.hoisted(() => ({
  listUseQueryMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
    'aria-current': ariaCurrent,
  }: {
    children: React.ReactNode;
    params: { planId: string };
    'aria-current'?: 'page';
  }) => (
    <a href={`/plans/${params.planId}/shopping`} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    plans: { list: { useQuery: listUseQueryMock } },
  },
}));

// Pin "today" so the short-range labels resolve within the current year.
vi.mock('@/lib/date-utils.ts', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/date-utils.ts')>()),
  todayInLondon: () => '2026-07-12',
}));

import { ShoppingPlanPicker } from './plan-picker.tsx';

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

function setup(active: PlanListItem[], future: PlanListItem[]): void {
  listUseQueryMock.mockImplementation((input: { status: string }) => ({
    data: { items: input.status === 'active' ? active : future },
  }));
}

beforeEach(() => {
  listUseQueryMock.mockReset();
});

describe('ShoppingPlanPicker', () => {
  it('renders nothing when only one live plan exists', () => {
    setup([plan(1, '2026-07-06', '2026-07-12')], []);
    const { container } = render(<ShoppingPlanPicker currentPlanId={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a tab per live plan, ordered by start date', () => {
    setup(
      [plan(1, '2026-07-06', '2026-07-12')],
      [plan(2, '2026-07-13', '2026-07-19')],
    );
    render(<ShoppingPlanPicker currentPlanId={2} />);

    const tabs = screen.getAllByRole('link');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('6 – 12 Jul');
    expect(tabs[1]).toHaveTextContent('13 – 19 Jul');
    expect(tabs[0]).toHaveAttribute('href', '/plans/1/shopping');
    expect(tabs[1]).toHaveAttribute('href', '/plans/2/shopping');
  });

  it('marks the current plan with aria-current', () => {
    setup(
      [plan(1, '2026-07-06', '2026-07-12')],
      [plan(2, '2026-07-13', '2026-07-19')],
    );
    render(<ShoppingPlanPicker currentPlanId={2} />);

    expect(screen.getByRole('link', { name: /13 – 19 Jul/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.getByRole('link', { name: /6 – 12 Jul/ }),
    ).not.toHaveAttribute('aria-current');
  });
});
