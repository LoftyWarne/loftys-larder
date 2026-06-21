import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PlantPointsBadge } from './plant-points-badge.tsx';

describe('PlantPointsBadge', () => {
  it('renders the count with a day-level accessible label', () => {
    render(<PlantPointsBadge count={3} />);
    const badge = screen.getByLabelText('3 plant points');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('3');
  });

  it('renders a plan-variant accessible label when variant=plan', () => {
    render(<PlantPointsBadge count={12} variant="plan" />);
    expect(
      screen.getByLabelText('12 plant points in this plan'),
    ).toBeInTheDocument();
  });

  it('renders a skeleton with a loading role when count is null', () => {
    render(<PlantPointsBadge count={null} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText(/plant points/)).toBeNull();
  });

  it('renders zero as a visible badge (not a skeleton)', () => {
    render(<PlantPointsBadge count={0} />);
    expect(screen.getByLabelText('0 plant points')).toHaveTextContent('0');
  });
});
