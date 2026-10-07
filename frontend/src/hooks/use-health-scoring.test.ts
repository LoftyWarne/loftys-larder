import type {
  HealthScoresDueResult,
  ScoreRecipeHealthInput,
  ScoreRecipeHealthResult,
} from '@loftys-larder/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { scoreMock, dueFetchMock, getInvalidateMock, listInvalidateMock } =
  vi.hoisted(() => ({
    scoreMock: vi.fn(),
    dueFetchMock: vi.fn(),
    getInvalidateMock: vi.fn().mockResolvedValue(undefined),
    listInvalidateMock: vi.fn().mockResolvedValue(undefined),
  }));

const utils = {
  healthScores: { due: { fetch: dueFetchMock } },
  recipes: {
    get: { invalidate: getInvalidateMock },
    list: { invalidate: listInvalidateMock },
  },
};

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => utils,
    healthScores: {
      score: { useMutation: () => ({ mutateAsync: scoreMock }) },
    },
  },
}));

import { useHealthScoringQueue } from './use-health-scoring.ts';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

function scored(): ScoreRecipeHealthResult {
  return {
    outcome: 'scored',
    healthScore: {
      score: 7,
      isStale: false,
      summary: 'Fine.',
      suggestion: null,
      model: 'fake',
      scoredAt: '2026-10-07T10:00:00.000Z',
    },
  };
}

function due(...ids: number[]): HealthScoresDueResult {
  return {
    recipes: ids.map((recipeId) => ({ recipeId, reason: 'not_scored' })),
  };
}

function domainError(code: string, extra: Record<string, unknown> = {}) {
  return new TRPCClientError('failed', {
    result: {
      error: {
        code: -32000,
        message: 'failed',
        data: { code: 'BAD_REQUEST', cause: { code, ...extra } },
      },
    },
  });
}

interface Deferred {
  resolve: (value: ScoreRecipeHealthResult) => void;
  reject: (error: unknown) => void;
}

// Scores wait until the test settles them, in call order.
function holdScores(): { calls: ScoreRecipeHealthInput[]; held: Deferred[] } {
  const calls: ScoreRecipeHealthInput[] = [];
  const held: Deferred[] = [];
  scoreMock.mockImplementation(
    (input: ScoreRecipeHealthInput) =>
      new Promise<ScoreRecipeHealthResult>((resolve, reject) => {
        calls.push(input);
        held.push({ resolve, reject });
      }),
  );
  return { calls, held };
}

beforeEach(() => {
  setOnline(true);
  scoreMock.mockReset();
  scoreMock.mockResolvedValue(scored());
  dueFetchMock.mockReset();
  getInvalidateMock.mockClear();
  listInvalidateMock.mockClear();
});

afterEach(() => {
  setOnline(true);
});

describe('useHealthScoringQueue', () => {
  it('asks which recipes are due after a save, then scores each one at a time', async () => {
    dueFetchMock.mockResolvedValue(due(5, 6));
    const { calls, held } = holdScores();
    const { result } = renderHook(() => useHealthScoringQueue());

    act(() => {
      result.current.scoreAfterSave(5);
    });
    expect(dueFetchMock).toHaveBeenCalledWith(
      { recipeId: 5 },
      { staleTime: 0 },
    );
    await waitFor(() => {
      expect(calls).toEqual([{ recipeId: 5, rescore: false }]);
    });
    expect([...result.current.scoringIds]).toEqual([5, 6]);

    await act(async () => {
      held[0]?.resolve(scored());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(calls).toEqual([
        { recipeId: 5, rescore: false },
        { recipeId: 6, rescore: false },
      ]);
    });
    expect([...result.current.scoringIds]).toEqual([6]);
    expect(getInvalidateMock).toHaveBeenCalledWith({ id: 5 });
    expect(listInvalidateMock).toHaveBeenCalled();

    await act(async () => {
      held[1]?.resolve(scored());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.scoringIds.size).toBe(0);
    });
    expect(getInvalidateMock).toHaveBeenCalledWith({ id: 6 });
  });

  it('scores nothing when nothing is due', async () => {
    dueFetchMock.mockResolvedValue(due());
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.scoreAfterSave(5);
    });
    await waitFor(() => {
      expect(dueFetchMock).toHaveBeenCalled();
    });
    expect(scoreMock).not.toHaveBeenCalled();
    expect(result.current.scoringIds.size).toBe(0);
  });

  it('does nothing after a save while offline', () => {
    setOnline(false);
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.scoreAfterSave(5);
      result.current.score(5, true);
    });
    expect(dueFetchMock).not.toHaveBeenCalled();
    expect(scoreMock).not.toHaveBeenCalled();
    expect(result.current.scoringIds.size).toBe(0);
  });

  it('drops what’s left when the connection goes', async () => {
    dueFetchMock.mockResolvedValue(due(5, 6));
    const { calls, held } = holdScores();
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.scoreAfterSave(5);
    });
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    setOnline(false);
    await act(async () => {
      held[0]?.resolve(scored());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.scoringIds.size).toBe(0);
    });
    expect(calls).toHaveLength(1);
  });

  it('says nothing when an automatic score fails', async () => {
    dueFetchMock.mockResolvedValue(due(5));
    scoreMock.mockRejectedValue(domainError('HEALTH_SCORE_TRY_AGAIN'));
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.scoreAfterSave(5);
    });
    await waitFor(() => {
      expect(result.current.scoringIds.size).toBe(0);
    });
    expect(scoreMock).toHaveBeenCalled();
    expect(result.current.failures.size).toBe(0);
  });

  it('ignores a failed due check', async () => {
    dueFetchMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.scoreAfterSave(5);
    });
    await waitFor(() => {
      expect(dueFetchMock).toHaveBeenCalled();
    });
    expect(scoreMock).not.toHaveBeenCalled();
  });

  it('scores or rescores for a cook', async () => {
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.score(5, true);
    });
    await waitFor(() => {
      expect(result.current.scoringIds.size).toBe(0);
    });
    expect(scoreMock).toHaveBeenCalledWith({ recipeId: 5, rescore: true });
    expect(result.current.failures.size).toBe(0);
  });

  it.each([
    [
      'rate limited',
      domainError('HEALTH_SCORE_RATE_LIMITED', { retryAfterSeconds: 600 }),
      { kind: 'rate_limited', retryAfterSeconds: 600 },
    ],
    [
      'not scored',
      domainError('HEALTH_SCORE_NOT_SCORED'),
      { kind: 'not_scored' },
    ],
    ['try again', domainError('HEALTH_SCORE_TRY_AGAIN'), { kind: 'try_again' }],
    ['any other error', new Error('boom'), { kind: 'try_again' }],
  ])('keeps why a cook’s score failed: %s', async (_label, error, failure) => {
    scoreMock.mockRejectedValue(error);
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.score(5, false);
    });
    await waitFor(() => {
      expect(result.current.failures.get(5)).toEqual(failure);
    });
    expect(result.current.scoringIds.size).toBe(0);
  });

  it('tells a cook a recipe with nothing to score needs ingredients', async () => {
    scoreMock.mockResolvedValue({
      outcome: 'nothing_to_score',
      healthScore: null,
    });
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.score(5, false);
    });
    await waitFor(() => {
      expect(result.current.failures.get(5)).toEqual({
        kind: 'nothing_to_score',
      });
    });
  });

  it('clears a failure when the recipe is scored again', async () => {
    scoreMock.mockRejectedValueOnce(domainError('HEALTH_SCORE_TRY_AGAIN'));
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.score(5, false);
    });
    await waitFor(() => {
      expect(result.current.failures.has(5)).toBe(true);
    });
    act(() => {
      result.current.score(5, false);
    });
    expect(result.current.failures.has(5)).toBe(false);
    await waitFor(() => {
      expect(result.current.scoringIds.size).toBe(0);
    });
    expect(result.current.failures.has(5)).toBe(false);
  });

  it('queues a recipe once, keeping a cook’s Rescore', async () => {
    const { calls, held } = holdScores();
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.score(1, false);
      result.current.score(5, false);
      result.current.score(5, true);
    });
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await act(async () => {
      held[0]?.resolve(scored());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]).toEqual({ recipeId: 5, rescore: true });
    await act(async () => {
      held[1]?.resolve(scored());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.scoringIds.size).toBe(0);
    });
    expect(calls).toHaveLength(2);
  });

  it('scores a recipe again when it’s saved while being scored', async () => {
    dueFetchMock.mockResolvedValue(due(5));
    const { calls, held } = holdScores();
    const { result } = renderHook(() => useHealthScoringQueue());
    act(() => {
      result.current.scoreAfterSave(5);
    });
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    act(() => {
      result.current.scoreAfterSave(5);
    });
    await waitFor(() => {
      expect(dueFetchMock).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      held[0]?.resolve({ outcome: 'changed', healthScore: null });
      await Promise.resolve();
    });
    // Still waiting for its second score.
    expect(result.current.scoringIds.has(5)).toBe(true);
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    await act(async () => {
      held[1]?.resolve(scored());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.scoringIds.size).toBe(0);
    });
  });
});
