import type { Config } from '../../config.ts';
import { createAnthropicClient } from '../model-features/anthropic-client.ts';
import { createAnthropicRecipeScorer } from './anthropic.ts';
import { createFakeRecipeScorer } from './fake.ts';
import type { RecipeScorer } from './types.ts';

export type RecipeScorerConfig = Pick<
  Config,
  | 'HEALTH_SCORE_ADAPTER'
  | 'HEALTH_SCORE_MODEL'
  | 'HEALTH_SCORE_EFFORT'
  | 'ANTHROPIC_API_KEY'
>;

// Config picks the adapter and model (DEC-112); `fake` is refused in
// production by config validation.
export function createRecipeScorer(
  config: RecipeScorerConfig,
  options: { fetch?: typeof fetch } = {},
): RecipeScorer {
  switch (config.HEALTH_SCORE_ADAPTER) {
    case 'fake':
      return createFakeRecipeScorer();
    case 'anthropic': {
      if (!config.ANTHROPIC_API_KEY) {
        throw new Error(
          'ANTHROPIC_API_KEY is required for the anthropic scorer',
        );
      }
      return createAnthropicRecipeScorer({
        client: createAnthropicClient({
          apiKey: config.ANTHROPIC_API_KEY,
          fetch: options.fetch,
        }),
        model: config.HEALTH_SCORE_MODEL,
        effort: config.HEALTH_SCORE_EFFORT,
      });
    }
  }
}
