import type { RecipeHealthScoreDetail } from '@loftys-larder/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HealthScoringContext,
  type HealthScoreFailure,
  type HealthScoring,
} from '@/hooks/use-health-scoring.ts';

const { useOnlineStatusMock } = vi.hoisted(() => ({
  useOnlineStatusMock: vi.fn(() => true),
}));

vi.mock('@/hooks/use-online-status.ts', () => ({
  useOnlineStatus: useOnlineStatusMock,
}));

import { RecipeHealthScore } from './recipe-health-score.tsx';

const SCORE: RecipeHealthScoreDetail = {
  score: 7,
  isStale: false,
  summary: 'Plenty of lentils and veg, but quite salty.',
  suggestion: 'Halve the stock cube.',
  model: 'claude-opus-5-5',
  scoredAt: '2026-10-07T09:30:00.000Z',
};

function scoring(overrides: Partial<HealthScoring> = {}): HealthScoring {
  return {
    scoringIds: new Set(),
    failures: new Map(),
    scoreAfterSave: vi.fn(),
    score: vi.fn(),
    ...overrides,
  };
}

function renderSection(
  props: Partial<React.ComponentProps<typeof RecipeHealthScore>> = {},
  context: HealthScoring = scoring(),
) {
  render(
    <HealthScoringContext.Provider value={context}>
      <RecipeHealthScore
        recipeId={5}
        healthScore={SCORE}
        hasIngredients
        isDeleted={false}
        {...props}
      />
    </HealthScoringContext.Provider>,
  );
  return context;
}

beforeEach(() => {
  useOnlineStatusMock.mockReturnValue(true);
});

describe('RecipeHealthScore', () => {
  it('shows the score, summary, Suggestion, when it was scored and by which model', () => {
    renderSection();
    expect(
      screen.getByRole('heading', { name: 'AI health score' }),
    ).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('out of 10')).toBeInTheDocument();
    expect(screen.getByText(SCORE.summary ?? '')).toBeInTheDocument();
    expect(screen.getByText('Suggestion:')).toBeInTheDocument();
    expect(screen.getByText(/Halve the stock cube\./)).toBeInTheDocument();
    expect(
      screen.getByText('Scored 7 Oct 2026 by claude-opus-5-5'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
  });

  it('leaves the Suggestion out when there isn’t one', () => {
    renderSection({ healthScore: { ...SCORE, suggestion: null } });
    expect(screen.queryByText('Suggestion:')).not.toBeInTheDocument();
  });

  it('renders model text as plain text', () => {
    renderSection({
      healthScore: { ...SCORE, summary: '<b>bold</b> **not bold**' },
    });
    expect(screen.getByText('<b>bold</b> **not bold**')).toBeInTheDocument();
  });

  it('mutes an out-of-date score and says so', () => {
    renderSection({ healthScore: { ...SCORE, isStale: true } });
    expect(screen.getByText('· out of date')).toBeInTheDocument();
  });

  it('rescores a scored recipe', async () => {
    const context = renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Rescore' }));
    expect(context.score).toHaveBeenCalledWith(5, true);
  });

  it('shows Not scored yet with Score for an unscored recipe', async () => {
    const context = renderSection({ healthScore: null });
    expect(screen.getByText('Not scored yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Score' }));
    expect(context.score).toHaveBeenCalledWith(5, false);
  });

  it('shows Scoring… while a score is being made, with no button', () => {
    renderSection({}, scoring({ scoringIds: new Set([5]) }));
    expect(screen.getByRole('status')).toHaveTextContent('Scoring…');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('asks for ingredients when the recipe has none, with no button', () => {
    renderSection({ healthScore: null, hasIngredients: false });
    expect(
      screen.getByText('Add ingredients to get a health score'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('turns Score off while offline', () => {
    useOnlineStatusMock.mockReturnValue(false);
    renderSection({ healthScore: null });
    expect(screen.getByRole('button', { name: 'Score' })).toBeDisabled();
    expect(screen.getByText('Scoring needs a connection')).toBeInTheDocument();
  });

  it('turns Rescore off while offline', () => {
    useOnlineStatusMock.mockReturnValue(false);
    renderSection();
    expect(screen.getByRole('button', { name: 'Rescore' })).toBeDisabled();
  });

  it('keeps a deleted recipe’s score, with no button', () => {
    renderSection({ isDeleted: true });
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each<[HealthScoreFailure, string]>([
    [
      { kind: 'rate_limited', retryAfterSeconds: 600 },
      'You’ve scored a lot of recipes recently. Try again in 10 minutes.',
    ],
    [
      { kind: 'rate_limited', retryAfterSeconds: 20 },
      'You’ve scored a lot of recipes recently. Try again in 1 minute.',
    ],
    [{ kind: 'not_scored' }, 'This recipe couldn’t be scored.'],
    [{ kind: 'try_again' }, 'The score didn’t work. Try again.'],
    [{ kind: 'nothing_to_score' }, 'Add ingredients to get a health score.'],
  ])('says why a score failed: %o', (failure, message) => {
    renderSection({}, scoring({ failures: new Map([[5, failure]]) }));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('never calls the score an estimate', () => {
    renderSection({ healthScore: { ...SCORE, isStale: true } });
    expect(document.body).not.toHaveTextContent(/estimat/i);
  });
});
