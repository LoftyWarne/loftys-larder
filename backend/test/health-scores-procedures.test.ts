import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pino from 'pino';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { HealthScoreRequest } from '../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import { users } from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import { ingredients } from '../src/db/schema/ingredients.ts';
import { recipeHealthScores } from '../src/db/schema/recipe-health.ts';
import {
  recipeIngredients,
  recipeMethod,
  recipeSources,
  recipeTagLinks,
  recipeTags,
  recipes,
} from '../src/db/schema/recipes.ts';
import {
  ingredientCategories,
  preparationTypes,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import { loadScoredRecipe } from '../src/lib/health-score/request.ts';
import {
  createFakeRecipeScorer,
  FAKE_SCORER_CANDIDATE,
  FAKE_SCORER_MARKERS,
} from '../src/lib/recipe-scorer/fake.ts';
import {
  RecipeScorerTimeoutError,
  type RecipeScorer,
  type RecipeScoring,
} from '../src/lib/recipe-scorer/types.ts';
import type { ModelRateLimitVerdict } from '../src/plugins/rate-limit.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { HEALTH_SCORE_TIMEOUT_MS } from '../src/trpc/procedures/health-scores.ts';
import { appRouter } from '../src/trpc/router.ts';
import { contextDeps } from './helpers/context-deps.ts';
import {
  startTestDb,
  stopTestDb,
  TESTCONTAINER_BOOT_MS,
  type TestDb,
} from './helpers/test-db.ts';

type Schema = typeof schema;

const USER_ID = 'user-health-test-1';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009cc';
const SINCE = '2026-10-07';

interface LineSeed {
  ingredientId: number;
  quantity: string;
  prepTypeId?: number | null;
  isOptional?: boolean;
}

interface RecipeSeed {
  name: string;
  baseServings?: number;
  isBase?: boolean;
  baseRecipeId?: number | null;
  isDeleted?: boolean;
  householdId?: string;
  lines?: LineSeed[];
  steps?: string[];
  caloriesPerServing?: number | null;
  saltPerServing?: number | null;
  nutritionIsEstimated?: boolean;
}

describe('health score procedures', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let onionId!: number;
  let lentilsId!: number;
  let oilId!: number;
  let riceId!: number;
  let outsiderId!: number;
  let choppedId!: number;

  beforeAll(async () => {
    testDb = await startTestDb({ poolMax: 4 });
    db = testDb.db;
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    await stopTestDb(testDb);
  });

  beforeEach(async () => {
    await db.execute(sql`
      truncate table
        ${recipeHealthScores},
        ${recipeTagLinks},
        ${recipeTags},
        ${recipeMethod},
        ${recipeIngredients},
        ${recipes},
        ${recipeSources},
        ${ingredients},
        ${preparationTypes},
        ${ingredientCategories},
        ${unitsOfMeasurement},
        ${households},
        ${users}
      restart identity cascade
    `);
    await db.insert(households).values([
      { id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" },
      { id: OTHER_HOUSEHOLD_ID, name: 'Other Household' },
    ]);
    await db.insert(users).values({
      id: USER_ID,
      email: 'health@example.com',
      name: 'Health Tester',
      emailVerified: true,
    });
    const [category] = await db
      .insert(ingredientCategories)
      .values({ name: 'Fruit & Veg' })
      .returning();
    const [g, ml] = await db
      .insert(unitsOfMeasurement)
      .values([{ name: 'g' }, { name: 'ml' }])
      .returning();
    const [chopped] = await db
      .insert(preparationTypes)
      .values({ name: 'chopped' })
      .returning();
    if (!category || !g || !ml || !chopped) throw new Error('seed failed');
    choppedId = chopped.id;
    const seeded = await db
      .insert(ingredients)
      .values(
        [
          ['Onion', g.id, CURRENT_HOUSEHOLD_ID],
          ['Red Lentils', g.id, CURRENT_HOUSEHOLD_ID],
          ['Olive Oil', ml.id, CURRENT_HOUSEHOLD_ID],
          ['Rice', g.id, CURRENT_HOUSEHOLD_ID],
          ['Outsider', g.id, OTHER_HOUSEHOLD_ID],
        ].map(([name, unitId, householdId]) => ({
          householdId: householdId as string,
          name: name as string,
          categoryId: category.id,
          defaultUnitId: unitId as number,
          isPlant: true,
        })),
      )
      .returning({ id: ingredients.id });
    const [onion, lentils, oil, rice, outsider] = seeded;
    if (!onion || !lentils || !oil || !rice || !outsider) {
      throw new Error('ingredient seed failed');
    }
    onionId = onion.id;
    lentilsId = lentils.id;
    oilId = oil.id;
    riceId = rice.id;
    outsiderId = outsider.id;
  });

  async function seedRecipe(seed: RecipeSeed): Promise<number> {
    const [row] = await db
      .insert(recipes)
      .values({
        householdId: seed.householdId ?? CURRENT_HOUSEHOLD_ID,
        name: seed.name,
        baseServings: seed.baseServings ?? 4,
        isBase: seed.isBase ?? false,
        baseRecipeId: seed.baseRecipeId ?? null,
        isDeleted: seed.isDeleted ?? false,
        caloriesPerServing: seed.caloriesPerServing ?? null,
        saltPerServing: seed.saltPerServing ?? null,
        nutritionIsEstimated: seed.nutritionIsEstimated ?? false,
      })
      .returning({ id: recipes.id });
    if (!row) throw new Error('recipe seed failed');
    const lines = seed.lines ?? [{ ingredientId: lentilsId, quantity: '250' }];
    if (lines.length > 0) {
      await db.insert(recipeIngredients).values(
        lines.map((line) => ({
          recipeId: row.id,
          ingredientId: line.ingredientId,
          quantity: line.quantity,
          prepTypeId: line.prepTypeId ?? null,
          isOptional: line.isOptional ?? false,
        })),
      );
    }
    const steps = seed.steps ?? ['Simmer everything.'];
    if (steps.length > 0) {
      await db.insert(recipeMethod).values(
        steps.map((instruction, index) => ({
          recipeId: row.id,
          stepNumber: index + 1,
          instruction,
        })),
      );
    }
    return row.id;
  }

  async function seedScore(
    recipeId: number,
    values: { isStale?: boolean; scoredAt?: Date; score?: number } = {},
  ) {
    await db.insert(recipeHealthScores).values({
      recipeId,
      score: values.score ?? 4,
      summary: 'An earlier summary.',
      suggestion: 'An earlier suggestion.',
      model: 'earlier-model',
      scoredAt: values.scoredAt ?? new Date('2026-10-08T10:00:00Z'),
      isStale: values.isStale ?? false,
    });
  }

  async function scoreRow(recipeId: number) {
    const [row] = await db
      .select()
      .from(recipeHealthScores)
      .where(eq(recipeHealthScores.recipeId, recipeId));
    return row ?? null;
  }

  interface ContextOptions {
    scorer?: RecipeScorer;
    allowScore?: () => Promise<ModelRateLimitVerdict>;
    since?: string;
    log?: AppContext['log'];
    authenticated?: boolean;
  }

  function makeContext(options: ContextOptions = {}): AppContext {
    const authenticated = options.authenticated ?? true;
    const deps = contextDeps();
    return {
      ...deps,
      req: {} as AppContext['req'],
      reply: {} as AppContext['reply'],
      reqId: 'rid-test',
      db,
      cloudinary: {
        cloudName: 'test-cloud',
        apiKey: 'test-key',
        apiSecret: 'test-secret',
      },
      session: authenticated
        ? {
            id: 'session-health-1',
            userId: USER_ID,
            token: 'tok',
            expiresAt: new Date(Date.now() + 60_000),
            ipAddress: null,
            userAgent: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
      user: authenticated
        ? {
            id: USER_ID,
            email: 'health@example.com',
            name: 'Health Tester',
            emailVerified: true,
            image: null,
            themePreference: 'system',
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
      log: options.log ?? deps.log,
      healthScore: {
        scorer: options.scorer ?? createFakeRecipeScorer(),
        since: options.since ?? SINCE,
        allowScore:
          options.allowScore ??
          (() => Promise.resolve({ allowed: true, retryAfterSeconds: 0 })),
      },
    };
  }

  function caller(options: ContextOptions = {}) {
    return appRouter.createCaller(makeContext(options));
  }

  function spyScorer(
    inner: RecipeScorer = createFakeRecipeScorer(),
    during?: () => Promise<void>,
  ) {
    const requests: HealthScoreRequest[] = [];
    const scorer: RecipeScorer = {
      adapter: inner.adapter,
      model: inner.model,
      score: async (request, signal) => {
        requests.push(request);
        await during?.();
        return inner.score(request, signal);
      },
    };
    return { scorer, requests };
  }

  function stubScorer(scoring: RecipeScoring): RecipeScorer {
    return {
      adapter: 'fake',
      model: 'stub',
      score: () => Promise.resolve(scoring),
    };
  }

  describe('building the request', () => {
    it('sends a standalone recipe’s lines, steps and nutrition', async () => {
      const id = await seedRecipe({
        name: 'Lentil Soup',
        baseServings: 4,
        lines: [
          { ingredientId: onionId, quantity: '150', prepTypeId: choppedId },
          { ingredientId: lentilsId, quantity: '250.5' },
          { ingredientId: oilId, quantity: '15', isOptional: true },
        ],
        steps: ['Soften the onion.', 'Add the lentils.'],
        caloriesPerServing: 410,
        saltPerServing: 1.25,
        nutritionIsEstimated: true,
      });
      const scored = await loadScoredRecipe(db, id);
      expect(scored).toEqual({
        isDeleted: false,
        request: {
          recipe: {
            name: 'Lentil Soup',
            kind: 'standalone',
            baseServings: 4,
            lines: [
              {
                name: 'Onion',
                quantity: 150,
                unit: 'g',
                prepType: 'chopped',
                isOptional: false,
              },
              {
                name: 'Red Lentils',
                quantity: 250.5,
                unit: 'g',
                prepType: null,
                isOptional: false,
              },
              {
                name: 'Olive Oil',
                quantity: 15,
                unit: 'ml',
                prepType: null,
                isOptional: true,
              },
            ],
            steps: ['Soften the onion.', 'Add the lentils.'],
            nutrition: {
              caloriesPerServing: 410,
              fatPerServing: null,
              saturatedFatPerServing: null,
              carbsPerServing: null,
              sugarPerServing: null,
              fibrePerServing: null,
              proteinPerServing: null,
              saltPerServing: 1.25,
            },
            nutritionIsEstimated: true,
          },
          base: null,
        },
      });
    });

    it('marks a base recipe as a base, with no base of its own', async () => {
      const id = await seedRecipe({ name: 'Ragu', isBase: true });
      const scored = await loadScoredRecipe(db, id);
      expect(scored?.request.recipe.kind).toBe('base');
      expect(scored?.request.base).toBeNull();
    });

    it('sends a serving variation with its base’s servings, lines and steps', async () => {
      const baseId = await seedRecipe({
        name: 'Ragu',
        isBase: true,
        baseServings: 8,
        lines: [{ ingredientId: onionId, quantity: '400' }],
        steps: ['Brown the onion.', 'Simmer for two hours.'],
      });
      const id = await seedRecipe({
        name: 'Ragu with Rice',
        baseServings: 2,
        baseRecipeId: baseId,
        lines: [{ ingredientId: riceId, quantity: '150' }],
        steps: ['Cook the rice.'],
      });
      const scored = await loadScoredRecipe(db, id);
      expect(scored?.request.recipe).toMatchObject({
        kind: 'variation',
        baseServings: 2,
        lines: [{ name: 'Rice', quantity: 150 }],
        steps: ['Cook the rice.'],
      });
      expect(scored?.request.base).toEqual({
        baseServings: 8,
        lines: [
          {
            name: 'Onion',
            quantity: 400,
            unit: 'g',
            prepType: null,
            isOptional: false,
          },
        ],
        steps: ['Brown the onion.', 'Simmer for two hours.'],
      });
    });

    it('sends nothing beyond what the score is based on', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      const [source] = await db
        .insert(recipeSources)
        .values({ householdId: CURRENT_HOUSEHOLD_ID, name: 'SECRET-SOURCE' })
        .returning();
      const [tag] = await db
        .insert(recipeTags)
        .values({ householdId: CURRENT_HOUSEHOLD_ID, name: 'SECRET-TAG' })
        .returning();
      if (!source || !tag) throw new Error('seed failed');
      await db.insert(recipeTagLinks).values({ recipeId: id, tagId: tag.id });
      await db
        .update(recipes)
        .set({
          description: 'SECRET-DESCRIPTION',
          imageUrl: 'https://example.com/SECRET-IMAGE.jpg',
          activeTimeMins: 731,
          totalTimeMins: 977,
          estimatedCostPerServing: '93.21',
          sourceId: source.id,
          sourceUrl: 'https://example.com/SECRET-URL',
          sourceDetail: 'SECRET-DETAIL',
        })
        .where(eq(recipes.id, id));
      await db
        .update(recipeMethod)
        .set({
          tip: 'SECRET-TIP',
          safetyNote: 'SECRET-SAFETY',
          prepAhead: 'required',
        })
        .where(eq(recipeMethod.recipeId, id));

      const scored = await loadScoredRecipe(db, id);
      const sent = JSON.stringify(scored?.request);
      for (const secret of [
        'SECRET',
        '731',
        '977',
        '93.21',
        'required',
        'prepAhead',
        'plant',
      ]) {
        expect(sent).not.toContain(secret);
      }
      expect(Object.keys(scored?.request.recipe ?? {}).sort()).toEqual([
        'baseServings',
        'kind',
        'lines',
        'name',
        'nutrition',
        'nutritionIsEstimated',
        'steps',
      ]);
    });

    it('doesn’t find a recipe in another household', async () => {
      const id = await seedRecipe({
        name: 'Elsewhere',
        householdId: OTHER_HOUSEHOLD_ID,
        lines: [{ ingredientId: outsiderId, quantity: '1' }],
      });
      expect(await loadScoredRecipe(db, id)).toBeNull();
    });
  });

  describe('score', () => {
    it('writes a new score with its summary, Suggestion and model', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      const result = await caller().healthScores.score({
        recipeId: id,
        rescore: false,
      });
      expect(result).toMatchObject({
        outcome: 'scored',
        healthScore: {
          score: 7,
          isStale: false,
          summary: FAKE_SCORER_CANDIDATE.summary,
          suggestion: FAKE_SCORER_CANDIDATE.suggestion,
          model: 'fake',
        },
      });
      const row = await scoreRow(id);
      expect(row).toMatchObject({
        score: 7,
        summary: FAKE_SCORER_CANDIDATE.summary,
        suggestion: FAKE_SCORER_CANDIDATE.suggestion,
        model: 'fake',
        isStale: false,
      });
      expect(row?.scoredAt.toISOString()).toBe(result.healthScore?.scoredAt);
    });

    it('writes no Suggestion when there isn’t one', async () => {
      const id = await seedRecipe({
        name: `Soup ${FAKE_SCORER_MARKERS.noSuggestion}`,
      });
      await caller().healthScores.score({ recipeId: id, rescore: false });
      expect((await scoreRow(id))?.suggestion).toBeNull();
    });

    it('records the model that answered, not the one asked for', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await caller({
        scorer: stubScorer({
          outcome: { kind: 'candidate', candidate: FAKE_SCORER_CANDIDATE },
          usage: { model: 'fallback-model', inputTokens: 1, outputTokens: 1 },
        }),
      }).healthScores.score({ recipeId: id, rescore: false });
      expect((await scoreRow(id))?.model).toBe('fallback-model');
    });

    it('strips markdown before writing', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await caller({
        scorer: stubScorer({
          outcome: {
            kind: 'candidate',
            candidate: {
              score: 8,
              summary: '**Lots** of _fibre_.',
              suggestion: '`Less salt`.',
            },
          },
          usage: { model: 'stub', inputTokens: 1, outputTokens: 1 },
        }),
      }).healthScores.score({ recipeId: id, rescore: false });
      expect(await scoreRow(id)).toMatchObject({
        summary: 'Lots of fibre.',
        suggestion: 'Less salt.',
      });
    });

    it('replaces an out-of-date score and clears is_stale', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await seedScore(id, { isStale: true, score: 3 });
      const result = await caller().healthScores.score({
        recipeId: id,
        rescore: false,
      });
      expect(result.outcome).toBe('scored');
      expect(await scoreRow(id)).toMatchObject({
        score: 7,
        isStale: false,
        model: 'fake',
      });
    });

    it('gives a current score back with no model call', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await seedScore(id);
      const { scorer, requests } = spyScorer();
      const allowScore = vi.fn(() =>
        Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
      );
      const result = await caller({ scorer, allowScore }).healthScores.score({
        recipeId: id,
        rescore: false,
      });
      expect(result).toMatchObject({
        outcome: 'current',
        healthScore: { score: 4, model: 'earlier-model' },
      });
      expect(requests).toHaveLength(0);
      expect(allowScore).not.toHaveBeenCalled();
    });

    it('rescores a current score when asked to', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await seedScore(id);
      const result = await caller().healthScores.score({
        recipeId: id,
        rescore: true,
      });
      expect(result.outcome).toBe('scored');
      expect((await scoreRow(id))?.score).toBe(7);
    });

    it('scores again a score from before HEALTH_SCORE_SINCE', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await seedScore(id, { scoredAt: new Date('2026-09-01T10:00:00Z') });
      const result = await caller().healthScores.score({
        recipeId: id,
        rescore: false,
      });
      expect(result.outcome).toBe('scored');
    });

    it('discards the result when the recipe changes during the call, keeping no score', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      const { scorer } = spyScorer(createFakeRecipeScorer(), async () => {
        await db
          .update(recipeIngredients)
          .set({ quantity: '300' })
          .where(eq(recipeIngredients.recipeId, id));
      });
      const result = await caller({ scorer }).healthScores.score({
        recipeId: id,
        rescore: false,
      });
      expect(result).toEqual({ outcome: 'changed', healthScore: null });
      expect(await scoreRow(id)).toBeNull();
    });

    it('discards the result when the recipe changes during the call, keeping the score it had', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await seedScore(id, { isStale: true, score: 3 });
      const { scorer } = spyScorer(createFakeRecipeScorer(), async () => {
        await db
          .update(recipeMethod)
          .set({ instruction: 'Simmer for longer.' })
          .where(eq(recipeMethod.recipeId, id));
      });
      const result = await caller({ scorer }).healthScores.score({
        recipeId: id,
        rescore: false,
      });
      expect(result).toMatchObject({
        outcome: 'changed',
        healthScore: { score: 3, isStale: true },
      });
      expect(await scoreRow(id)).toMatchObject({ score: 3, isStale: true });
    });

    it('discards the result when the variation’s base changes during the call', async () => {
      const baseId = await seedRecipe({ name: 'Ragu', isBase: true });
      const id = await seedRecipe({
        name: 'Ragu with Rice',
        baseRecipeId: baseId,
      });
      const { scorer } = spyScorer(createFakeRecipeScorer(), async () => {
        await db
          .update(recipes)
          .set({ baseServings: 10 })
          .where(eq(recipes.id, baseId));
      });
      const result = await caller({ scorer }).healthScores.score({
        recipeId: id,
        rescore: false,
      });
      expect(result.outcome).toBe('changed');
    });

    it('writes when the lines are saved again unchanged during the call', async () => {
      const id = await seedRecipe({
        name: 'Lentil Soup',
        lines: [{ ingredientId: lentilsId, quantity: '250' }],
      });
      const { scorer } = spyScorer(createFakeRecipeScorer(), async () => {
        // Save & Finish re-sends the same lines; the DB pads the quantity.
        await db
          .delete(recipeIngredients)
          .where(eq(recipeIngredients.recipeId, id));
        await db.insert(recipeIngredients).values({
          recipeId: id,
          ingredientId: lentilsId,
          quantity: '250.000',
        });
      });
      const result = await caller({ scorer }).healthScores.score({
        recipeId: id,
        rescore: false,
      });
      expect(result.outcome).toBe('scored');
    });

    it('discards the result when the recipe is deleted during the call', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      const { scorer } = spyScorer(createFakeRecipeScorer(), async () => {
        await db
          .update(recipes)
          .set({ isDeleted: true })
          .where(eq(recipes.id, id));
      });
      const result = await caller({ scorer }).healthScores.score({
        recipeId: id,
        rescore: false,
      });
      expect(result.outcome).toBe('changed');
      expect(await scoreRow(id)).toBeNull();
    });

    it('never sends a recipe with no ingredient lines', async () => {
      const id = await seedRecipe({ name: 'Empty', lines: [] });
      const { scorer, requests } = spyScorer();
      const result = await caller({ scorer }).healthScores.score({
        recipeId: id,
        rescore: true,
      });
      expect(result).toEqual({
        outcome: 'nothing_to_score',
        healthScore: null,
      });
      expect(requests).toHaveLength(0);
    });

    it('scores a variation with no lines of its own from its base’s', async () => {
      const baseId = await seedRecipe({ name: 'Ragu', isBase: true });
      const id = await seedRecipe({
        name: 'Ragu, plain',
        baseRecipeId: baseId,
        lines: [],
      });
      const result = await caller().healthScores.score({
        recipeId: id,
        rescore: false,
      });
      expect(result.outcome).toBe('scored');
    });

    it('doesn’t score a soft-deleted recipe, which keeps its score', async () => {
      const id = await seedRecipe({ name: 'Old Soup', isDeleted: true });
      await seedScore(id, { isStale: true, score: 2 });
      const { scorer, requests } = spyScorer();
      const result = await caller({ scorer }).healthScores.score({
        recipeId: id,
        rescore: true,
      });
      expect(result).toMatchObject({
        outcome: 'deleted',
        healthScore: { score: 2, isStale: true },
      });
      expect(requests).toHaveLength(0);
      expect(await scoreRow(id)).toMatchObject({ score: 2, isStale: true });
    });

    it('refuses calls beyond the limit without calling the model', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      const { scorer, requests } = spyScorer();
      await expect(
        caller({
          scorer,
          allowScore: () =>
            Promise.resolve({ allowed: false, retryAfterSeconds: 1200 }),
        }).healthScores.score({ recipeId: id, rescore: false }),
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        cause: { code: 'HEALTH_SCORE_RATE_LIMITED', retryAfterSeconds: 1200 },
      });
      expect(requests).toHaveLength(0);
      expect(await scoreRow(id)).toBeNull();
    });

    it.each([
      [FAKE_SCORER_MARKERS.timeout, 'GATEWAY_TIMEOUT', 'timeout'],
      [FAKE_SCORER_MARKERS.unavailable, 'SERVICE_UNAVAILABLE', 'unavailable'],
      [FAKE_SCORER_MARKERS.invalid, 'BAD_GATEWAY', 'invalid_result'],
    ])(
      'asks to try again for %s and writes nothing',
      async (marker, code, reason) => {
        const id = await seedRecipe({ name: `Soup ${marker}` });
        await seedScore(id, { isStale: true, score: 3 });
        await expect(
          caller().healthScores.score({ recipeId: id, rescore: false }),
        ).rejects.toMatchObject({
          code,
          cause: { code: 'HEALTH_SCORE_TRY_AGAIN', reason },
        });
        expect(await scoreRow(id)).toMatchObject({ score: 3, isStale: true });
      },
    );

    it('says the recipe couldn’t be scored when every model refuses, and writes nothing', async () => {
      const id = await seedRecipe({
        name: `Soup ${FAKE_SCORER_MARKERS.refused}`,
      });
      await expect(
        caller().healthScores.score({ recipeId: id, rescore: false }),
      ).rejects.toMatchObject({
        code: 'UNPROCESSABLE_CONTENT',
        cause: { code: 'HEALTH_SCORE_NOT_SCORED' },
      });
      expect(await scoreRow(id)).toBeNull();
    });

    it('reports a request the provider refused, and writes nothing', async () => {
      const id = await seedRecipe({
        name: `Soup ${FAKE_SCORER_MARKERS.rejected}`,
      });
      await expect(
        caller().healthScores.score({ recipeId: id, rescore: false }),
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        cause: { code: 'HEALTH_SCORE_REQUEST_REJECTED' },
      });
      expect(await scoreRow(id)).toBeNull();
    });

    it('gives up after 45 seconds', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      const deadline = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(deadline.signal);
      let scoring = false;
      const scorer: RecipeScorer = {
        adapter: 'fake',
        model: 'slow',
        score: (_request, signal) =>
          new Promise((_resolve, reject) => {
            scoring = true;
            signal.addEventListener('abort', () => {
              reject(new RecipeScorerTimeoutError());
            });
          }),
      };
      try {
        const pending = caller({ scorer }).healthScores.score({
          recipeId: id,
          rescore: false,
        });
        await vi.waitFor(() => {
          expect(scoring).toBe(true);
        });
        deadline.abort();
        await expect(pending).rejects.toMatchObject({
          code: 'GATEWAY_TIMEOUT',
          cause: { code: 'HEALTH_SCORE_TRY_AGAIN', reason: 'timeout' },
        });
        expect(timeout).toHaveBeenCalledWith(HEALTH_SCORE_TIMEOUT_MS);
        expect(HEALTH_SCORE_TIMEOUT_MS).toBe(45_000);
      } finally {
        timeout.mockRestore();
      }
      expect(await scoreRow(id)).toBeNull();
    });

    it('doesn’t score a recipe in another household', async () => {
      const id = await seedRecipe({
        name: 'Elsewhere',
        householdId: OTHER_HOUSEHOLD_ID,
        lines: [{ ingredientId: outsiderId, quantity: '1' }],
      });
      await expect(
        caller().healthScores.score({ recipeId: id, rescore: false }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await scoreRow(id)).toBeNull();
    });

    it('needs a signed-in user', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await expect(
        caller({ authenticated: false }).healthScores.score({
          recipeId: id,
          rescore: false,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('logs metadata only, with the request id', async () => {
      const lines: string[] = [];
      const log = pino(
        { level: 'info' },
        { write: (line) => lines.push(line) },
      ).child({ reqId: 'req-health-1' });
      const id = await seedRecipe({
        name: 'Grandmas Secret Stew',
        steps: ['Stir the secret spice in.'],
      });
      await caller({ log }).healthScores.score({
        recipeId: id,
        rescore: false,
      });
      const refusedId = await seedRecipe({
        name: `Secret Soup ${FAKE_SCORER_MARKERS.refused}`,
      });
      await expect(
        caller({ log }).healthScores.score({
          recipeId: refusedId,
          rescore: false,
        }),
      ).rejects.toBeDefined();

      const entries = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => 'modelUsage' in entry);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        reqId: 'req-health-1',
        modelUsage: {
          feature: 'health-score',
          recipeId: id,
          recipeKind: 'standalone',
          lineCount: 1,
          rescore: false,
          adapter: 'fake',
          model: 'fake',
          inputTokens: 0,
          outputTokens: 0,
          outcome: 'scored',
        },
      });
      expect(entries[0]?.modelUsage).toHaveProperty('latencyMs');
      expect(entries[1]?.modelUsage).toMatchObject({
        outcome: 'HEALTH_SCORE_NOT_SCORED',
      });

      const output = lines.join('');
      expect(output).not.toContain('Secret');
      expect(output).not.toContain('secret');
      expect(output).not.toContain(FAKE_SCORER_CANDIDATE.summary);
      expect(output).not.toContain(FAKE_SCORER_CANDIDATE.suggestion ?? '');
    });
  });

  describe('reads', () => {
    it('returns the Suggestion and model from recipes.get, and leaves recipes.list as it was', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await caller().healthScores.score({ recipeId: id, rescore: false });
      const recipe = await caller().recipes.get({ id });
      expect(recipe.healthScore).toMatchObject({
        score: 7,
        isStale: false,
        summary: FAKE_SCORER_CANDIDATE.summary,
        suggestion: FAKE_SCORER_CANDIDATE.suggestion,
        model: 'fake',
      });
      const list = await caller().recipes.list({});
      expect(list.items.find((item) => item.id === id)?.healthScore).toEqual({
        score: 7,
        isStale: false,
      });
    });
  });

  describe('due', () => {
    it('gives one recipe’s reason', async () => {
      const unscored = await seedRecipe({ name: 'Unscored' });
      const current = await seedRecipe({ name: 'Current' });
      await seedScore(current);
      expect(await caller().healthScores.due({ recipeId: unscored })).toEqual({
        recipes: [{ recipeId: unscored, reason: 'not_scored' }],
      });
      expect(await caller().healthScores.due({ recipeId: current })).toEqual({
        recipes: [],
      });
    });

    it('gives a base and its serving variations, and nothing else', async () => {
      const baseId = await seedRecipe({ name: 'Ragu', isBase: true });
      await seedScore(baseId, { isStale: true });
      const withRice = await seedRecipe({
        name: 'Ragu with Rice',
        baseRecipeId: baseId,
      });
      await seedScore(withRice, { isStale: true });
      const withPasta = await seedRecipe({
        name: 'Ragu with Pasta',
        baseRecipeId: baseId,
      });
      await seedScore(withPasta);
      await seedRecipe({ name: 'Unrelated' });
      expect(await caller().healthScores.due({ recipeId: baseId })).toEqual({
        recipes: [
          { recipeId: baseId, reason: 'out_of_date' },
          { recipeId: withRice, reason: 'out_of_date' },
        ],
      });
    });

    it('gives a score from before HEALTH_SCORE_SINCE as from an older scorer', async () => {
      const id = await seedRecipe({ name: 'Lentil Soup' });
      await seedScore(id, { scoredAt: new Date('2026-10-06T10:00:00Z') });
      expect(await caller().healthScores.due({ recipeId: id })).toEqual({
        recipes: [{ recipeId: id, reason: 'older_scorer' }],
      });
      expect(
        await caller({ since: '2026-10-06' }).healthScores.due({
          recipeId: id,
        }),
      ).toEqual({ recipes: [] });
    });

    it('never gives a recipe with no ingredient lines, but gives a variation whose base has some', async () => {
      const empty = await seedRecipe({ name: 'Empty', lines: [] });
      const baseId = await seedRecipe({ name: 'Ragu', isBase: true });
      await seedScore(baseId);
      const plain = await seedRecipe({
        name: 'Ragu, plain',
        baseRecipeId: baseId,
        lines: [],
      });
      const all = await caller().healthScores.due({});
      expect(all.recipes.map((row) => row.recipeId)).toEqual([plain]);
      expect(await caller().healthScores.due({ recipeId: empty })).toEqual({
        recipes: [],
      });
    });

    it('leaves out soft-deleted recipes', async () => {
      const id = await seedRecipe({ name: 'Old Soup', isDeleted: true });
      expect(await caller().healthScores.due({})).toEqual({ recipes: [] });
      expect(await caller().healthScores.due({ recipeId: id })).toEqual({
        recipes: [],
      });
    });

    it('gives every recipe in the household without a recipe id, and none from elsewhere', async () => {
      const a = await seedRecipe({ name: 'A' });
      const b = await seedRecipe({ name: 'B' });
      await seedScore(b, { isStale: true });
      const c = await seedRecipe({ name: 'C' });
      await seedScore(c);
      await seedRecipe({
        name: 'Elsewhere',
        householdId: OTHER_HOUSEHOLD_ID,
        lines: [{ ingredientId: outsiderId, quantity: '1' }],
      });
      expect(await caller().healthScores.due({})).toEqual({
        recipes: [
          { recipeId: a, reason: 'not_scored' },
          { recipeId: b, reason: 'out_of_date' },
        ],
      });
    });
  });
});
