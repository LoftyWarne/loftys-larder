import type Anthropic from '@anthropic-ai/sdk';

import { mealPlanCandidateSchema } from '../../../../shared/src/index.ts';
import type { ModelEffort } from '../../config.ts';
import { ANTHROPIC_REFUSAL_FALLBACK_BETA } from '../model-features/anthropic-client.ts';
import { classifyAnthropicError } from '../model-features/anthropic-errors.ts';
import { toStructuredOutputSchema } from '../model-features/structured-output-schema.ts';
import {
  buildMealPlannerUserMessage,
  MEAL_PLANNER_SYSTEM_PROMPT,
} from './anthropic-prompt.ts';
import {
  MealPlannerRequestError,
  MealPlannerTimeoutError,
  MealPlannerUnavailableError,
  type MealPlanner,
} from './types.ts';

// Structured outputs, as for scoring: the slots are an array of one small
// object, so the schema stays the same size however long the plan is.
const CANDIDATE_SCHEMA = toStructuredOutputSchema(mealPlanCandidateSchema);

// Room for thinking plus 28 reasons and a summary, and still under the SDK's
// limit for a non-streaming request.
const MAX_TOKENS = 16_000;

export interface AnthropicMealPlannerOptions {
  client: Anthropic;
  model: string;
  effort: ModelEffort;
}

export function createAnthropicMealPlanner(
  options: AnthropicMealPlannerOptions,
): MealPlanner {
  const { client, model, effort } = options;
  return {
    adapter: 'anthropic',
    model,
    async propose(request, signal) {
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create(
          {
            model,
            max_tokens: MAX_TOKENS,
            betas: [ANTHROPIC_REFUSAL_FALLBACK_BETA],
            fallbacks: 'default',
            output_config: {
              effort,
              format: { type: 'json_schema', schema: CANDIDATE_SCHEMA },
            },
            system: MEAL_PLANNER_SYSTEM_PROMPT,
            messages: [
              { role: 'user', content: buildMealPlannerUserMessage(request) },
            ],
          },
          { signal },
        );
      } catch (error) {
        throw toPlannerError(error, signal);
      }

      const usage = {
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      // A refusal from the whole fallback chain: no plan can be proposed.
      if (response.stop_reason === 'refusal') {
        return { outcome: { kind: 'refused' }, usage };
      }
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      return { outcome: { kind: 'candidate', candidate: parse(text) }, usage };
    },
  };
}

// Output that isn't JSON (cut off at `max_tokens`, say) becomes a candidate
// that fails normalisation.
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toPlannerError(error: unknown, signal: AbortSignal): unknown {
  const failure = classifyAnthropicError(error, signal);
  switch (failure?.kind) {
    case 'timeout':
      return new MealPlannerTimeoutError();
    case 'unavailable':
      return new MealPlannerUnavailableError(failure.status);
    case 'rejected':
      return new MealPlannerRequestError(
        failure.status,
        failure.providerErrorType,
        failure.providerMessage,
        failure.providerRequestId,
      );
    case undefined:
      return error;
  }
}
