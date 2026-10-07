import type { HealthScoreDueReason } from '../../../../shared/src/index.ts';
import { parseCivilDate, todayInLondon } from '../date-utils.ts';

export interface StoredHealthScore {
  isStale: boolean;
  scoredAt: Date;
}

// Why a recipe needs a score, or null when its score is current. `since` is
// HEALTH_SCORE_SINCE: a score from a London day before it came from an older
// model or prompt (DEC-112). Out of date wins over an older scorer.
export function healthScoreDueReason(
  score: StoredHealthScore | null,
  since: string,
): HealthScoreDueReason | null {
  if (score === null) return 'not_scored';
  if (score.isStale) return 'out_of_date';
  const scoredOn = todayInLondon(score.scoredAt).getTime();
  if (scoredOn < parseCivilDate(since).getTime()) {
    return 'older_scorer';
  }
  return null;
}
