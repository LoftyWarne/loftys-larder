import type { PlanSlot } from '@loftys-larder/shared';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: (props: { children: React.ReactNode }): React.ReactElement => (
    <a href="#">{props.children}</a>
  ),
}));

const todayMock = vi.fn<() => string>();
vi.mock('@/lib/date-utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/date-utils.ts')>()),
  todayInLondon: () => todayMock(),
}));

import { PlannerGrid } from './planner-grid.tsx';

const listeners: (() => void)[] = [];
const noop = (): void => undefined;

function setMedium(isMedium: boolean): void {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: query === '(min-width: 48rem)' ? isMedium : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: () => void) => {
        listeners.push(cb);
      },
      removeEventListener: (_type: string, cb: () => void) => {
        const index = listeners.indexOf(cb);
        if (index >= 0) listeners.splice(index, 1);
      },
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

function slot(
  id: number,
  date: string,
  occasionId: number,
  overrides: Partial<PlanSlot> = {},
): PlanSlot {
  return {
    id,
    planId: 1,
    date,
    occasionId,
    occasionName: occasionId === 2 ? 'Lunch' : 'Dinner',
    slotType: 'empty',
    leftoversSource: null,
    chefUserId: null,
    comment: null,
    items: [],
    dinerUserIds: [],
    guestCount: 0,
    ...overrides,
  };
}

// Three days, two occasions; Tuesday dinner has no slot row at all.
const SLOTS: PlanSlot[] = [
  slot(1, '2026-06-15', 2, { slotType: 'takeaway' }),
  slot(2, '2026-06-15', 3),
  slot(3, '2026-06-16', 2),
  slot(5, '2026-06-17', 2),
  slot(6, '2026-06-17', 3, { slotType: 'eat_out' }),
];

const scrollIntoView = vi.fn();

function renderGrid(
  props: Partial<React.ComponentProps<typeof PlannerGrid>> = {},
): void {
  render(
    <PlannerGrid
      slots={SLOTS}
      members={[]}
      rangeStart="2026-06-15"
      rangeEnd="2026-06-17"
      onSlotClick={noop}
      {...props}
    />,
  );
}

beforeEach(() => {
  listeners.length = 0;
  todayMock.mockReturnValue('2026-01-01');
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlannerGrid', () => {
  describe('at md and up', () => {
    beforeEach(() => {
      setMedium(true);
    });

    it('renders the grid', () => {
      renderGrid();
      expect(
        screen.getByRole('table', { name: 'Meal plan' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });

    it('renders each slot once', () => {
      const { container } = render(
        <PlannerGrid
          slots={SLOTS}
          members={[]}
          rangeStart="2026-06-15"
          rangeEnd="2026-06-17"
          onSlotClick={noop}
        />,
      );
      expect(container.querySelectorAll('[data-slot-id]')).toHaveLength(
        SLOTS.length,
      );
    });
  });

  describe('below md', () => {
    beforeEach(() => {
      setMedium(false);
    });

    it('renders one card per day instead of the grid', () => {
      renderGrid();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      const list = screen.getByRole('list', { name: 'Meal plan' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(3);
      expect(
        within(list).getByRole('region', { name: 'Tue 16th Jun 2026' }),
      ).toBeInTheDocument();
    });

    it('renders each slot once, in its day and occasion', () => {
      const { container } = render(
        <PlannerGrid
          slots={SLOTS}
          members={[]}
          rangeStart="2026-06-15"
          rangeEnd="2026-06-17"
          onSlotClick={noop}
        />,
      );
      expect(container.querySelectorAll('[data-slot-id]')).toHaveLength(
        SLOTS.length,
      );
      const monday = screen.getByRole('region', { name: 'Mon 15th Jun 2026' });
      expect(within(monday).getByText('Takeaway')).toBeInTheDocument();
      expect(within(monday).getByText('Add meal')).toBeInTheDocument();
    });

    it('marks today and scrolls to it once', () => {
      todayMock.mockReturnValue('2026-06-16');
      const { rerender } = render(
        <PlannerGrid
          slots={SLOTS}
          members={[]}
          rangeStart="2026-06-15"
          rangeEnd="2026-06-17"
          onSlotClick={noop}
        />,
      );
      const tuesday = screen.getByRole('region', {
        name: /^Tue 16th Jun 2026/,
      });
      expect(within(tuesday).getByText('Today')).toBeInTheDocument();
      expect(screen.getAllByText('Today')).toHaveLength(1);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      rerender(
        <PlannerGrid
          slots={[...SLOTS]}
          members={[]}
          rangeStart="2026-06-15"
          rangeEnd="2026-06-17"
          onSlotClick={noop}
        />,
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('does not scroll when today is the first day', () => {
      todayMock.mockReturnValue('2026-06-15');
      renderGrid();
      expect(screen.getByText('Today')).toBeInTheDocument();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('does not scroll when today is outside the range', () => {
      renderGrid();
      expect(screen.queryByText('Today')).not.toBeInTheDocument();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('shows each day’s plant-points badge', () => {
      renderGrid({
        dayPlantCounts: new Map<string, number | null>([
          ['2026-06-15', 4],
          ['2026-06-16', null],
        ]),
      });
      const monday = screen.getByRole('region', { name: 'Mon 15th Jun 2026' });
      expect(
        within(monday).getByLabelText('4 plant points'),
      ).toBeInTheDocument();
      const tuesday = screen.getByRole('region', {
        name: 'Tue 16th Jun 2026',
      });
      expect(
        within(tuesday).getByLabelText('Loading plant points'),
      ).toBeInTheDocument();
      const wednesday = screen.getByRole('region', {
        name: 'Wed 17th Jun 2026',
      });
      expect(
        within(wednesday).queryByTestId('plant-points-badge'),
      ).not.toBeInTheDocument();
    });

    it('shows each day’s health score badge', () => {
      renderGrid({
        dayHealthScores: new Map([
          [
            '2026-06-15',
            { average: 6.4, notScored: 0, includesOutOfDate: false },
          ],
          ['2026-06-16', null],
        ]),
      });
      const monday = screen.getByRole('region', { name: 'Mon 15th Jun 2026' });
      expect(
        within(monday).getByText('AI health score 6.4 out of 10'),
      ).toBeInTheDocument();
      const tuesday = screen.getByRole('region', {
        name: 'Tue 16th Jun 2026',
      });
      expect(
        within(tuesday).getByTestId('health-score-average-loading'),
      ).toBeInTheDocument();
      const wednesday = screen.getByRole('region', {
        name: 'Wed 17th Jun 2026',
      });
      expect(
        within(wednesday).queryByTestId('health-score-average'),
      ).not.toBeInTheDocument();
    });
  });

  it('switches layout when the viewport crosses md', () => {
    setMedium(false);
    renderGrid();
    expect(screen.getByRole('list', { name: 'Meal plan' })).toBeInTheDocument();

    act(() => {
      setMedium(true);
      for (const cb of [...listeners]) cb();
    });

    expect(
      screen.getByRole('table', { name: 'Meal plan' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
