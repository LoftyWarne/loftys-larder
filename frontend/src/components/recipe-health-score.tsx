import type { RecipeHealthScoreDetail } from '@loftys-larder/shared';

import { Button } from '@/components/ui/button.tsx';
import {
  useHealthScoring,
  type HealthScoreFailure,
} from '@/hooks/use-health-scoring.ts';
import { useOnlineStatus } from '@/hooks/use-online-status.ts';
import { cn } from '@/lib/utils.ts';

const SCORED_ON_FORMAT = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeZone: 'Europe/London',
});

// The recipe page's AI health score (DEC-112): the score, the summary, the
// Suggestion, when it was scored and by which model, with Score or Rescore.
// Model text renders as plain text (DEC-49). One neutral colour, and never
// called an estimate.
export function RecipeHealthScore({
  recipeId,
  healthScore,
  hasIngredients,
  isDeleted,
}: {
  recipeId: number;
  healthScore: RecipeHealthScoreDetail | null;
  // A serving variation counts its base's ingredients too.
  hasIngredients: boolean;
  isDeleted: boolean;
}): React.ReactElement {
  const scoring = useHealthScoring();
  const isOnline = useOnlineStatus();
  const isScoring = scoring.scoringIds.has(recipeId);
  const failure = scoring.failures.get(recipeId) ?? null;
  const canScore = hasIngredients && !isDeleted && !isScoring;

  return (
    <section className="space-y-2" aria-labelledby="health-score-heading">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="health-score-heading" className="text-xl font-semibold">
          AI health score
        </h2>
        {canScore && (
          <div className="flex items-center gap-2">
            {!isOnline && (
              <span className="text-xs text-muted-foreground">
                Scoring needs a connection
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!isOnline}
              onClick={() => {
                scoring.score(recipeId, healthScore !== null);
              }}
            >
              {healthScore ? 'Rescore' : 'Score'}
            </Button>
          </div>
        )}
      </div>
      {!hasIngredients ? (
        <p className="text-sm text-muted-foreground">
          Add ingredients to get a health score
        </p>
      ) : isScoring ? (
        <p role="status" className="text-sm text-muted-foreground">
          Scoring…
        </p>
      ) : healthScore ? (
        <ScoreDetail healthScore={healthScore} />
      ) : (
        <p className="text-sm text-muted-foreground">Not scored yet</p>
      )}
      {failure && !isScoring && (
        <p role="alert" className="text-sm text-destructive">
          {failureMessage(failure)}
        </p>
      )}
    </section>
  );
}

function ScoreDetail({
  healthScore,
}: {
  healthScore: RecipeHealthScoreDetail;
}): React.ReactElement {
  const { score, isStale, summary, suggestion, model, scoredAt } = healthScore;
  return (
    <div
      className={cn(
        'space-y-2 rounded-md border p-3',
        isStale && 'border-dashed text-muted-foreground',
      )}
    >
      <p className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold">{String(score)}</span>
        <span className="text-sm">out of 10</span>
        {isStale && <span className="text-sm">· out of date</span>}
      </p>
      {summary && <p className="text-sm">{summary}</p>}
      {suggestion && (
        <p className="text-sm">
          <span className="font-medium">Suggestion:</span> {suggestion}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Scored {SCORED_ON_FORMAT.format(new Date(scoredAt))} by {model}
      </p>
    </div>
  );
}

function failureMessage(failure: HealthScoreFailure): string {
  switch (failure.kind) {
    case 'rate_limited': {
      const minutes = Math.max(1, Math.ceil(failure.retryAfterSeconds / 60));
      return `You’ve scored a lot of recipes recently. Try again in ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}.`;
    }
    case 'not_scored':
      return 'This recipe couldn’t be scored.';
    case 'nothing_to_score':
      return 'Add ingredients to get a health score.';
    case 'try_again':
      return 'The score didn’t work. Try again.';
  }
}
