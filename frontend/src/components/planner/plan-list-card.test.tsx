import type { PlanListItem } from '@loftys-larder/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{props.children}</a>
  ),
}));

import { PlanListCard } from './plan-list-card.tsx';

const PLAN: PlanListItem = {
  id: 42,
  startDate: '2026-06-15',
  endDate: '2026-06-21',
  createdByUserId: 'user-1',
  slotsTotal: 14,
  slotsAssigned: 9,
};

describe('PlanListCard', () => {
  it('renders the date range and the slot-fill summary', () => {
    render(
      <PlanListCard plan={PLAN} onDuplicate={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(
      screen.getByText('Mon 15th – Sun 21st Jun 2026'),
    ).toBeInTheDocument();
    expect(screen.getByText('9/14 slots assigned')).toBeInTheDocument();
  });

  it('fires onDuplicate and onDelete with the plan', async () => {
    const user = userEvent.setup();
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    render(
      <PlanListCard
        plan={PLAN}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByRole('button', { name: /duplicate/i }));
    expect(onDuplicate).toHaveBeenCalledWith(PLAN);

    await user.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith(PLAN);
  });
});
