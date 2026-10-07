import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HealthScoreChip } from './health-score-chip.tsx';

describe('HealthScoreChip', () => {
  it('shows the score out of 10, named as an AI health score', () => {
    render(<HealthScoreChip healthScore={{ score: 7, isStale: false }} />);
    expect(screen.getByText('7/10')).toBeInTheDocument();
    expect(screen.getByText('AI health score 7 out of 10')).toBeInTheDocument();
    expect(screen.getByTitle('AI health score')).toBeInTheDocument();
    expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
  });

  it('is muted and says so when out of date', () => {
    render(<HealthScoreChip healthScore={{ score: 4, isStale: true }} />);
    expect(screen.getByText('· out of date')).toBeInTheDocument();
    expect(screen.getByTitle('AI health score')).toHaveClass(
      'text-muted-foreground',
    );
  });

  it('shows nothing for an unscored recipe', () => {
    const { container } = render(<HealthScoreChip healthScore={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows Scoring… while a score is being made', () => {
    render(
      <HealthScoreChip healthScore={{ score: 4, isStale: true }} isScoring />,
    );
    expect(screen.getByText('Scoring…')).toBeInTheDocument();
    expect(screen.queryByText('4/10')).not.toBeInTheDocument();
  });

  it('uses the same colour for every score and never says estimate', () => {
    const { rerender } = render(
      <HealthScoreChip healthScore={{ score: 2, isStale: false }} />,
    );
    const low = screen.getByTitle('AI health score').className;
    rerender(<HealthScoreChip healthScore={{ score: 9, isStale: false }} />);
    expect(screen.getByTitle('AI health score').className).toBe(low);
    expect(document.body).not.toHaveTextContent(/estimat/i);
  });
});
