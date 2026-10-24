import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PlannerDayCard } from './planner-day-card.tsx';

const OCCASIONS = [
  { id: 2, name: 'Lunch' },
  { id: 3, name: 'Dinner' },
];

function renderCard(
  props: Partial<React.ComponentProps<typeof PlannerDayCard>> = {},
): void {
  render(
    <PlannerDayCard
      date="2026-06-15"
      isToday={false}
      occasions={OCCASIONS}
      renderSlot={(occasionId) => <span>slot {occasionId}</span>}
      {...props}
    />,
  );
}

describe('PlannerDayCard', () => {
  it('heads the card with the long day label', () => {
    renderCard();
    expect(
      screen.getByRole('region', { name: 'Mon 15th Jun 2026' }),
    ).toBeInTheDocument();
  });

  it('renders a row per occasion with its slot', () => {
    renderCard();
    const region = screen.getByRole('region');
    expect(within(region).getByText('Lunch')).toBeInTheDocument();
    expect(within(region).getByText('slot 2')).toBeInTheDocument();
    expect(within(region).getByText('Dinner')).toBeInTheDocument();
    expect(within(region).getByText('slot 3')).toBeInTheDocument();
  });

  it('marks today', () => {
    renderCard({ isToday: true });
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('does not mark other days', () => {
    renderCard();
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
  });

  it('shows the plant-points badge when a count is given', () => {
    renderCard({ plantCount: 7 });
    expect(screen.getByLabelText('7 plant points')).toBeInTheDocument();
  });

  it('shows the loading badge while the count is null', () => {
    renderCard({ plantCount: null });
    expect(screen.getByLabelText('Loading plant points')).toBeInTheDocument();
  });

  it('hides the badge when there is no count', () => {
    renderCard();
    expect(screen.queryByTestId('plant-points-badge')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('plant-points-badge-loading'),
    ).not.toBeInTheDocument();
  });
});
