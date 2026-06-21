import { useMemo } from 'react';

import { trpc } from '@/lib/trpc.ts';

// Issue one `plants.forDay` query per visible date. tRPC's httpBatchLink
// coalesces the queries into a single HTTP request, so the planner pays one
// round-trip even with 14 days visible. Result is a map keyed by civil date,
// matching the shape consumed by `PlannerGrid.dayPlantCounts`. `null` for a
// date means the query is in-flight (badge shows a skeleton).
//
// Callers must pass a stable `dates` reference (e.g. via `useMemo`) so the
// underlying `useQueries` call gets the same options array across renders
// when the visible window hasn't changed.
export function useDayPlantPoints(
  planId: number,
  dates: readonly string[],
): ReadonlyMap<string, number | null> {
  const queries = trpc.useQueries((t) =>
    dates.map((date) => t.plants.forDay({ planId, date })),
  );

  return useMemo(() => {
    const map = new Map<string, number | null>();
    dates.forEach((date, index) => {
      const result = queries[index];
      if (!result) return;
      map.set(date, result.data?.count ?? null);
    });
    return map;
  }, [dates, queries]);
}
