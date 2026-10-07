import type Anthropic from '@anthropic-ai/sdk';

import { healthScoreCandidateSchema } from '../../../../shared/src/index.ts';
import type { ModelEffort } from '../../config.ts';
import { ANTHROPIC_REFUSAL_FALLBACK_BETA } from '../model-features/anthropic-client.ts';
import { classifyAnthropicError } from '../model-features/anthropic-errors.ts';
import { toStructuredOutputSchema } from '../model-features/structured-output-schema.ts';
import {
  buildHealthScorerUserMessage,
  HEALTH_SCORER_SYSTEM_PROMPT,
} from './anthropic-prompt.ts';
import {
  RecipeScorerRequestError,
  RecipeScorerTimeoutError,
  RecipeScorerUnavailableError,
  type RecipeScorer,
} from './types.ts';

// Structured outputs, unlike the reader: three fields are far below the
// grammar limit the import schema hit (DEC-109 amended, DEC-112).
const CANDIDATE_SCHEMA = toStructuredOutputSchema(healthScoreCandidateSchema);

// Room for thinking plus a short reply, and still under the SDK's limit for a
// non-streaming request.
const MAX_TOKENS = 16_000;

export interface AnthropicRecipeScorerOptions {
  client: Anthropic;
  model: string;
  effort: ModelEffort;
}

export function createAnthropicRecipeScorer(
  options: AnthropicRecipeScorerOptions,
): RecipeScorer {
  const { client, model, effort } = options;
  return {
    adapter: 'anthropic',
    model,
    async score(request, signal) {
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
            system: HEALTH_SCORER_SYSTEM_PROMPT,
            messages: [
              { role: 'user', content: buildHealthScorerUserMessage(request) },
            ],
          },
          { signal },
        );
      } catch (error) {
        throw toScorerError(error, signal);
      }

      const usage = {
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      // A refusal from the whole fallback chain: the recipe can't be scored.
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

function toScorerError(error: unknown, signal: AbortSignal): unknown {
  const failure = classifyAnthropicError(error, signal);
  switch (failure?.kind) {
    case 'timeout':
      return new RecipeScorerTimeoutError();
    case 'unavailable':
      return new RecipeScorerUnavailableError(failure.status);
    case 'rejected':
      return new RecipeScorerRequestError(
        failure.status,
        failure.providerErrorType,
        failure.providerMessage,
        failure.providerRequestId,
      );
    case undefined:
      return error;
  }
}
