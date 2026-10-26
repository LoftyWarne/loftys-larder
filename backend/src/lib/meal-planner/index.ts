import type { Config } from '../../config.ts';
import { createAnthropicClient } from '../model-features/anthropic-client.ts';
import { createAnthropicMealPlanner } from './anthropic.ts';
import { createFakeMealPlanner } from './fake.ts';
import type { MealPlanner } from './types.ts';

export type MealPlannerConfig = Pick<
  Config,
  | 'MEAL_PLAN_ADAPTER'
  | 'MEAL_PLAN_MODEL'
  | 'MEAL_PLAN_EFFORT'
  | 'ANTHROPIC_API_KEY'
>;

// Config picks the adapter and model (DEC-117); `fake` is refused in
// production by config validation.
export function createMealPlanner(
  config: MealPlannerConfig,
  options: { fetch?: typeof fetch } = {},
): MealPlanner {
  switch (config.MEAL_PLAN_ADAPTER) {
    case 'fake':
      return createFakeMealPlanner();
    case 'anthropic': {
      if (!config.ANTHROPIC_API_KEY) {
        throw new Error(
          'ANTHROPIC_API_KEY is required for the anthropic planner',
        );
      }
      return createAnthropicMealPlanner({
        client: createAnthropicClient({
          apiKey: config.ANTHROPIC_API_KEY,
          fetch: options.fetch,
        }),
        model: config.MEAL_PLAN_MODEL,
        effort: config.MEAL_PLAN_EFFORT,
      });
    }
  }
}
