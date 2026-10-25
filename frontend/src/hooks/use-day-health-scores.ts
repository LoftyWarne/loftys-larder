import type { HealthScoreAverage } from '@loftys-larder/shared';
import { useMemo } from 'react';

import { trpc } from '@/lib/trpc.ts';

// One `healthScores.forDay` query per visible date, batched into one request
// by httpBatchLink, as `useDayPlantPoints` does. `null` for a date means the
// query is in flight. Callers pass a stable `dates` reference.
export function useDayHealthScores(
  planId: number,
  dates: readonly string[],
): ReadonlyMap<string, HealthScoreAverage | null> {
  const queries = trpc.useQueries((t) =>
    dates.map((date) => t.healthScores.forDay({ planId, date })),
  );

  return useMemo(() => {
    const map = new Map<string, HealthScoreAverage | null>();
    dates.forEach((date, index) => {
      const result = queries[index];
      if (!result) return;
      map.set(date, result.data ?? null);
    });
    return map;
  }, [dates, queries]);
}
