import type { Config } from '../../config.ts';
import { createAnthropicClient } from '../model-features/anthropic-client.ts';
import { createAnthropicRecipeReader } from './anthropic.ts';
import { createFakeRecipeReader } from './fake.ts';
import type { RecipeReader } from './types.ts';

export type RecipeReaderConfig = Pick<
  Config,
  | 'RECIPE_IMPORT_ADAPTER'
  | 'RECIPE_IMPORT_MODEL'
  | 'RECIPE_IMPORT_EFFORT'
  | 'ANTHROPIC_API_KEY'
>;

// Config picks the adapter and model (DEC-109); `fake` is refused in
// production by config validation.
export function createRecipeReader(
  config: RecipeReaderConfig,
  options: { fetch?: typeof fetch } = {},
): RecipeReader {
  switch (config.RECIPE_IMPORT_ADAPTER) {
    case 'fake':
      return createFakeRecipeReader();
    case 'anthropic': {
      if (!config.ANTHROPIC_API_KEY) {
        throw new Error(
          'ANTHROPIC_API_KEY is required for the anthropic reader',
        );
      }
      return createAnthropicRecipeReader({
        client: createAnthropicClient({
          apiKey: config.ANTHROPIC_API_KEY,
          fetch: options.fetch,
        }),
        model: config.RECIPE_IMPORT_MODEL,
        effort: config.RECIPE_IMPORT_EFFORT,
      });
    }
  }
}
