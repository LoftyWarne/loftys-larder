import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HealthScoreAverageBadge } from './health-score-average-badge.tsx';

describe('HealthScoreAverageBadge', () => {
  it('shows the average to one decimal, labelled AI', () => {
    render(
      <HealthScoreAverageBadge
        value={{ average: 6, notScored: 0, includesOutOfDate: false }}
      />,
    );
    const badge = screen.getByTestId('health-score-average');
    expect(badge).toHaveTextContent('AI6.0');
    expect(badge).toHaveAttribute('title', 'AI health score 6.0 out of 10');
    expect(
      screen.getByText('AI health score 6.0 out of 10'),
    ).toBeInTheDocument();
  });

  it('mutes the badge when an out-of-date score went into it', () => {
    render(
      <HealthScoreAverageBadge
        value={{ average: 4.5, notScored: 0, includesOutOfDate: true }}
      />,
    );
    expect(
      screen.getByText('AI health score 4.5 out of 10, out of date'),
    ).toBeInTheDocument();
    expect(screen.getByText('AI').parentElement).toHaveClass('border-dashed');
  });

  it('keeps the day badge’s not-scored note to its name and tooltip', () => {
    render(
      <HealthScoreAverageBadge
        value={{ average: 7.2, notScored: 2, includesOutOfDate: false }}
      />,
    );
    const description = 'AI health score 7.2 out of 10, 2 dishes not scored';
    expect(screen.getByTestId('health-score-average')).toHaveAttribute(
      'title',
      description,
    );
    expect(screen.getAllByText(/not scored/)).toHaveLength(1);
  });

  it('shows the plan badge’s not-scored note and out-of-date mark', () => {
    render(
      <HealthScoreAverageBadge
        variant="plan"
        value={{ average: 5.1, notScored: 1, includesOutOfDate: true }}
      />,
    );
    expect(screen.getByText('· out of date')).toBeInTheDocument();
    expect(screen.getByText('1 dish not scored')).toBeInTheDocument();
    expect(
      screen.getByText(
        'AI health score 5.1 out of 10 for this plan, out of date, 1 dish not scored',
      ),
    ).toBeInTheDocument();
  });

  it('shows nothing on a day with no scored dish', () => {
    const { container } = render(
      <HealthScoreAverageBadge
        value={{ average: null, notScored: 2, includesOutOfDate: false }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows only the not-scored note on a plan with no scored dish', () => {
    render(
      <HealthScoreAverageBadge
        variant="plan"
        value={{ average: null, notScored: 3, includesOutOfDate: false }}
      />,
    );
    expect(screen.getByText('3 dishes not scored')).toBeInTheDocument();
    expect(screen.queryByTestId('health-score-average')).toBeNull();
  });

  it('shows nothing on a plan with no eaten dishes', () => {
    const { container } = render(
      <HealthScoreAverageBadge
        variant="plan"
        value={{ average: null, notScored: 0, includesOutOfDate: false }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a loading skeleton while the value is null', () => {
    render(<HealthScoreAverageBadge value={null} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading AI health score',
    );
  });
});
