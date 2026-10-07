import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

import { getDomainErrorCause } from '@/lib/domain-error.ts';
import { trpc } from '@/lib/trpc.ts';

// Health scoring from the browser (DEC-112). Recipes are scored one at a time
// in the background, so a cook never waits on one, and the state lives above
// the routes, so the recipe page shows "Scoring…" after the edit page has
// navigated away (DEC-09). Nothing is scored while offline: what's left is
// dropped, and the recipe stays unscored or out of date.

export type HealthScoreFailure =
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'not_scored' }
  | { kind: 'nothing_to_score' }
  | { kind: 'try_again' };

export interface HealthScoring {
  // Recipes waiting to be scored or being scored.
  scoringIds: ReadonlySet<number>;
  // Why a cook's Score or Rescore didn't give a score. Automatic scoring
  // fails silently.
  failures: ReadonlyMap<number, HealthScoreFailure>;
  // After Save & Finish or "Create recipe": scores whichever of the recipe
  // and its serving variations need a score.
  scoreAfterSave: (recipeId: number) => void;
  // Score or Rescore on the recipe page.
  score: (recipeId: number, rescore: boolean) => void;
}

interface QueuedScore {
  recipeId: number;
  rescore: boolean;
  // Asked for by a cook, so a failure is shown.
  byCook: boolean;
}

const inert: HealthScoring = {
  scoringIds: new Set(),
  failures: new Map(),
  scoreAfterSave: () => undefined,
  score: () => undefined,
};

export const HealthScoringContext = createContext<HealthScoring>(inert);

export function useHealthScoring(): HealthScoring {
  return useContext(HealthScoringContext);
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function toFailure(error: unknown): HealthScoreFailure {
  const cause = getDomainErrorCause(error);
  switch (cause?.code) {
    case 'HEALTH_SCORE_RATE_LIMITED': {
      const seconds: unknown = cause.retryAfterSeconds;
      return {
        kind: 'rate_limited',
        retryAfterSeconds: typeof seconds === 'number' ? seconds : 0,
      };
    }
    case 'HEALTH_SCORE_NOT_SCORED':
      return { kind: 'not_scored' };
    default:
      return { kind: 'try_again' };
  }
}

// The provider's state. One instance, in `HealthScoringProvider`.
export function useHealthScoringQueue(): HealthScoring {
  const utils = trpc.useUtils();
  const { mutateAsync: scoreRecipe } = trpc.healthScores.score.useMutation();
  const [scoringIds, setScoringIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [failures, setFailures] = useState<
    ReadonlyMap<number, HealthScoreFailure>
  >(() => new Map());
  const queue = useRef<QueuedScore[]>([]);
  const running = useRef(false);

  const drain = useCallback(async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    try {
      for (
        let next = queue.current.shift();
        next !== undefined;
        next = queue.current.shift()
      ) {
        const item = next;
        if (!isOnline()) {
          queue.current = [];
          setScoringIds(new Set());
          return;
        }
        let failure: HealthScoreFailure | null = null;
        try {
          const result = await scoreRecipe({
            recipeId: item.recipeId,
            rescore: item.rescore,
          });
          if (result.outcome === 'nothing_to_score') {
            failure = { kind: 'nothing_to_score' };
          }
        } catch (error) {
          failure = toFailure(error);
        }
        if (failure && item.byCook) {
          const shown = failure;
          setFailures((previous) =>
            new Map(previous).set(item.recipeId, shown),
          );
        }
        // Saved again while it was being scored: it's queued once more.
        if (!queue.current.some((q) => q.recipeId === item.recipeId)) {
          setScoringIds((previous) => {
            const ids = new Set(previous);
            ids.delete(item.recipeId);
            return ids;
          });
        }
        await Promise.all([
          utils.recipes.get.invalidate({ id: item.recipeId }),
          utils.recipes.list.invalidate(),
        ]);
      }
    } finally {
      running.current = false;
    }
  }, [scoreRecipe, utils]);

  const enqueue = useCallback(
    (items: readonly QueuedScore[]): void => {
      if (items.length === 0) return;
      for (const item of items) {
        const queued = queue.current.find((q) => q.recipeId === item.recipeId);
        if (queued) {
          queued.rescore ||= item.rescore;
          queued.byCook ||= item.byCook;
        } else {
          queue.current.push({ ...item });
        }
      }
      setScoringIds((previous) => {
        const ids = new Set(previous);
        for (const item of items) ids.add(item.recipeId);
        return ids;
      });
      setFailures((previous) => {
        const next = new Map(previous);
        for (const item of items) next.delete(item.recipeId);
        return next;
      });
      void drain();
    },
    [drain],
  );

  const scoreAfterSave = useCallback(
    (recipeId: number): void => {
      if (!isOnline()) return;
      void utils.healthScores.due.fetch({ recipeId }, { staleTime: 0 }).then(
        (due) => {
          enqueue(
            due.recipes.map((row) => ({
              recipeId: row.recipeId,
              rescore: false,
              byCook: false,
            })),
          );
        },
        // Left unscored or out of date, for the next save or Rescore.
        () => undefined,
      );
    },
    [enqueue, utils],
  );

  const score = useCallback(
    (recipeId: number, rescore: boolean): void => {
      if (!isOnline()) return;
      enqueue([{ recipeId, rescore, byCook: true }]);
    },
    [enqueue],
  );

  return useMemo(
    () => ({ scoringIds, failures, scoreAfterSave, score }),
    [scoringIds, failures, scoreAfterSave, score],
  );
}
