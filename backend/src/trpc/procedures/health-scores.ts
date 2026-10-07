import { isDeepStrictEqual } from 'node:util';

import { TRPCError } from '@trpc/server';
import { and, asc, eq, or, sql } from 'drizzle-orm';

import {
  healthScoresDueInputSchema,
  healthScoresDueResultSchema,
  scoreRecipeHealthInputSchema,
  scoreRecipeHealthResultSchema,
  type DomainErrorCode,
  type HealthScoresDueResult,
  type RecipeHealthScoreDetail,
  type ScoreRecipeHealthResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { recipeHealthScores } from '../../db/schema/recipe-health.ts';
import { recipeIngredients, recipes } from '../../db/schema/recipes.ts';
import { makeWithTransaction } from '../../db/withTransaction.ts';
import { healthScoreDueReason } from '../../lib/health-score/due.ts';
import { normaliseHealthScore } from '../../lib/health-score/normalise.ts';
import {
  loadScoredRecipe,
  scoredLineCount,
} from '../../lib/health-score/request.ts';
import {
  logModelUsage,
  type ModelUsageDetails,
} from '../../lib/model-features/usage-log.ts';
import { pickableRecipesWhere } from '../../lib/pickable-recipes.ts';
import {
  RecipeScorerRequestError,
  RecipeScorerTimeoutError,
  RecipeScorerUnavailableError,
  type RecipeScorerUsage,
  type RecipeScoring,
} from '../../lib/recipe-scorer/types.ts';
import { protectedProcedure, router } from '../init.ts';

// Confirmed at FEAT-66 kick-off (DEC-112), with the client's one retry inside
// it.
export const HEALTH_SCORE_TIMEOUT_MS = 45_000;

const FEATURE = 'health-score';

type TryAgainReason = 'timeout' | 'unavailable' | 'invalid_result';

export const healthScoresRouter = router({
  // Scores one recipe (DEC-112). The browser calls it after Save & Finish and
  // "Create recipe", and a cook calls it with Score or Rescore. The model is
  // called outside any transaction; the write happens only if the recipe is
  // as it was when it was sent.
  score: protectedProcedure
    .input(scoreRecipeHealthInputSchema)
    .output(scoreRecipeHealthResultSchema)
    .mutation(
      async ({ ctx, input, signal }): Promise<ScoreRecipeHealthResult> => {
        const { recipeId } = input;
        const { scorer, since, allowScore } = ctx.healthScore;

        const scored = await loadScoredRecipe(ctx.db, recipeId);
        if (!scored) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Recipe not found',
          });
        }
        // The cheap checks: none of these call the model or count towards
        // the limit.
        const existing = await loadHealthScore(ctx.db, recipeId);
        const healthScore = existing && toDetail(existing);
        if (scored.isDeleted) {
          return { outcome: 'deleted', healthScore };
        }
        const lineCount = scoredLineCount(scored.request);
        if (lineCount === 0) {
          return { outcome: 'nothing_to_score', healthScore };
        }
        if (!input.rescore && healthScoreDueReason(existing, since) === null) {
          return { outcome: 'current', healthScore };
        }

        const verdict = await allowScore();
        if (!verdict.allowed) {
          throw domainError(
            'TOO_MANY_REQUESTS',
            'HEALTH_SCORE_RATE_LIMITED',
            'Too many health scores for now',
            { retryAfterSeconds: verdict.retryAfterSeconds },
          );
        }

        const timeout = AbortSignal.timeout(HEALTH_SCORE_TIMEOUT_MS);
        const scoreSignal = signal
          ? AbortSignal.any([signal, timeout])
          : timeout;
        const startedAt = performance.now();
        // Metadata only: never the recipe's text, the summary or the
        // Suggestion (DEC-112).
        const logUsage = (
          outcome: string,
          usage: RecipeScorerUsage | null,
          details: ModelUsageDetails = {},
        ) => {
          logModelUsage(
            ctx.log,
            {
              feature: FEATURE,
              adapter: scorer.adapter,
              model: usage?.model ?? scorer.model,
              inputTokens: usage?.inputTokens ?? null,
              outputTokens: usage?.outputTokens ?? null,
              latencyMs: Math.round(performance.now() - startedAt),
              outcome,
            },
            {
              recipeId,
              recipeKind: scored.request.recipe.kind,
              lineCount,
              rescore: input.rescore,
              ...details,
            },
          );
        };

        let scoring: RecipeScoring;
        try {
          scoring = await scorer.score(scored.request, scoreSignal);
        } catch (error) {
          if (error instanceof RecipeScorerTimeoutError) {
            logUsage('HEALTH_SCORE_TRY_AGAIN', null, { reason: 'timeout' });
            throw tryAgain('timeout');
          }
          if (error instanceof RecipeScorerUnavailableError) {
            logUsage('HEALTH_SCORE_TRY_AGAIN', null, {
              reason: 'unavailable',
              providerStatus: error.status,
            });
            throw tryAgain('unavailable');
          }
          // Our request was wrong, so the provider's reason is kept for
          // whoever fixes it. It reaches Sentry with the domain code only.
          if (error instanceof RecipeScorerRequestError) {
            logUsage('HEALTH_SCORE_REQUEST_REJECTED', null, {
              providerStatus: error.status,
              providerErrorType: error.providerErrorType,
              providerMessage: error.providerMessage,
              providerRequestId: error.providerRequestId,
            });
            throw domainError(
              'INTERNAL_SERVER_ERROR',
              'HEALTH_SCORE_REQUEST_REJECTED',
              'The health scorer refused the request',
            );
          }
          throw error;
        }

        const { outcome, usage } = scoring;
        if (outcome.kind === 'refused') {
          logUsage('HEALTH_SCORE_NOT_SCORED', usage);
          throw domainError(
            'UNPROCESSABLE_CONTENT',
            'HEALTH_SCORE_NOT_SCORED',
            'This recipe couldn’t be scored',
          );
        }
        const result = normaliseHealthScore(outcome.candidate);
        if (!result) {
          logUsage('HEALTH_SCORE_TRY_AGAIN', usage, {
            reason: 'invalid_result',
          });
          throw tryAgain('invalid_result');
        }

        const withTransaction = makeWithTransaction(ctx.db);
        const written = await withTransaction(async (tx) => {
          // The same code that built what was sent, so the two compare
          // exactly (DEC-112). A recipe deleted during the call isn't
          // written either.
          const now = await loadScoredRecipe(tx, recipeId);
          if (
            !now ||
            now.isDeleted ||
            !isDeepStrictEqual(now.request, scored.request)
          ) {
            return null;
          }
          const values = {
            score: result.score,
            summary: result.summary,
            suggestion: result.suggestion,
            model: usage.model,
            scoredAt: sql`now()`,
            isStale: false,
          };
          const [row] = await tx
            .insert(recipeHealthScores)
            .values({ recipeId, ...values })
            .onConflictDoUpdate({
              target: recipeHealthScores.recipeId,
              set: values,
            })
            .returning();
          return row ?? null;
        });
        if (!written) {
          logUsage('changed', usage);
          const kept = await loadHealthScore(ctx.db, recipeId);
          return { outcome: 'changed', healthScore: kept && toDetail(kept) };
        }
        logUsage('scored', usage, { score: written.score });
        return { outcome: 'scored', healthScore: toDetail(written) };
      },
    ),

  // Which recipes need a score, and why (DEC-112). A recipe with no
  // ingredient lines, its own or its base's, is never due, and neither is a
  // soft-deleted one.
  due: protectedProcedure
    .input(healthScoresDueInputSchema)
    .output(healthScoresDueResultSchema)
    .query(async ({ ctx, input }): Promise<HealthScoresDueResult> => {
      const hasIngredientLines = sql`exists (
        select 1 from ${recipeIngredients}
        where ${recipeIngredients.recipeId} in (${recipes.id}, ${recipes.baseRecipeId})
      )`;
      const rows = await ctx.db
        .select({
          recipeId: recipes.id,
          isStale: recipeHealthScores.isStale,
          scoredAt: recipeHealthScores.scoredAt,
        })
        .from(recipes)
        .leftJoin(
          recipeHealthScores,
          eq(recipeHealthScores.recipeId, recipes.id),
        )
        .where(
          and(
            pickableRecipesWhere(),
            input.recipeId === undefined
              ? undefined
              : or(
                  eq(recipes.id, input.recipeId),
                  eq(recipes.baseRecipeId, input.recipeId),
                ),
            hasIngredientLines,
          ),
        )
        .orderBy(asc(recipes.id));
      return {
        recipes: rows.flatMap((row) => {
          const reason = healthScoreDueReason(
            row.isStale === null || row.scoredAt === null
              ? null
              : { isStale: row.isStale, scoredAt: row.scoredAt },
            ctx.healthScore.since,
          );
          return reason === null ? [] : [{ recipeId: row.recipeId, reason }];
        }),
      };
    }),
});

interface HealthScoreRow {
  score: number;
  isStale: boolean;
  summary: string | null;
  suggestion: string | null;
  model: string;
  scoredAt: Date;
}

// Scoped through the join to `recipes` (DEC-17).
async function loadHealthScore(
  db: Db,
  recipeId: number,
): Promise<HealthScoreRow | null> {
  const [row] = await db
    .select({
      score: recipeHealthScores.score,
      isStale: recipeHealthScores.isStale,
      summary: recipeHealthScores.summary,
      suggestion: recipeHealthScores.suggestion,
      model: recipeHealthScores.model,
      scoredAt: recipeHealthScores.scoredAt,
    })
    .from(recipeHealthScores)
    .innerJoin(recipes, eq(recipes.id, recipeHealthScores.recipeId))
    .where(
      and(
        eq(recipeHealthScores.recipeId, recipeId),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  return row ?? null;
}

function toDetail(row: HealthScoreRow): RecipeHealthScoreDetail {
  return {
    score: row.score,
    isStale: row.isStale,
    summary: row.summary,
    suggestion: row.suggestion,
    model: row.model,
    scoredAt: row.scoredAt.toISOString(),
  };
}

// Timeouts, outages and unusable results are server-side failures, so they
// reach Sentry, with the domain code and reason only (DEC-104).
function tryAgain(reason: TryAgainReason): TRPCError {
  const code =
    reason === 'timeout'
      ? 'GATEWAY_TIMEOUT'
      : reason === 'unavailable'
        ? 'SERVICE_UNAVAILABLE'
        : 'BAD_GATEWAY';
  return domainError(code, 'HEALTH_SCORE_TRY_AGAIN', 'The score didn’t work', {
    reason,
  });
}

function domainError(
  code: TRPCError['code'],
  domainCode: DomainErrorCode,
  message: string,
  metadata: Record<string, unknown> = {},
): TRPCError {
  return new TRPCError({
    code,
    message,
    cause: { code: domainCode, ...metadata },
  });
}
