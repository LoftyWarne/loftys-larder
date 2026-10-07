import type Anthropic from '@anthropic-ai/sdk';

import type { ModelEffort } from '../../config.ts';
import { ANTHROPIC_REFUSAL_FALLBACK_BETA } from '../model-features/anthropic-client.ts';
import { classifyAnthropicError } from '../model-features/anthropic-errors.ts';
import {
  buildRecipeReaderUserMessage,
  RECIPE_READER_SYSTEM_PROMPT,
} from './anthropic-prompt.ts';
import {
  RecipeReaderRequestError,
  RecipeReaderTimeoutError,
  RecipeReaderUnavailableError,
  type RecipeReader,
  type RecipeReaderOutcome,
} from './types.ts';

// Room for thinking plus a long proposal, and still under the SDK's limit for
// a non-streaming request.
const MAX_TOKENS = 16_000;

export interface AnthropicRecipeReaderOptions {
  client: Anthropic;
  model: string;
  effort: ModelEffort;
}

export function createAnthropicRecipeReader(
  options: AnthropicRecipeReaderOptions,
): RecipeReader {
  const { client, model, effort } = options;
  return {
    adapter: 'anthropic',
    model,
    async read(request, signal) {
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create(
          {
            model,
            max_tokens: MAX_TOKENS,
            betas: [ANTHROPIC_REFUSAL_FALLBACK_BETA],
            fallbacks: 'default',
            output_config: { effort },
            system: RECIPE_READER_SYSTEM_PROMPT,
            messages: [
              {
                role: 'user',
                content: buildRecipeReaderUserMessage(request),
              },
            ],
          },
          { signal },
        );
      } catch (error) {
        throw toReaderError(error, signal);
      }

      const usage = {
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      // A recipe tripping a classifier is almost certainly a false positive,
      // which the fallback re-runs. A refusal from the whole chain is still
      // not a recipe.
      if (response.stop_reason === 'refusal') {
        return { outcome: { kind: 'not_a_recipe' }, usage };
      }
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      return { outcome: toOutcome(text), usage };
    },
  };
}

// Reads only the outcome envelope. The candidate goes back unvalidated, and
// output that isn't JSON (cut off at `max_tokens`, say) becomes a candidate
// that fails normalisation. The prompt asks for bare JSON, but a code fence
// or a sentence around the object is forgiven.
function toOutcome(text: string): RecipeReaderOutcome {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { kind: 'candidate', candidate: null };
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const envelope = parsed as Record<string, unknown>;
    if (envelope.outcome === 'not_a_recipe') return { kind: 'not_a_recipe' };
    if (envelope.outcome === 'several' && Array.isArray(envelope.names)) {
      return {
        kind: 'several',
        names: envelope.names.filter(
          (name): name is string => typeof name === 'string',
        ),
      };
    }
    if (envelope.outcome === 'recipe') {
      return { kind: 'candidate', candidate: envelope.recipe };
    }
  }
  return { kind: 'candidate', candidate: parsed };
}

function toReaderError(error: unknown, signal: AbortSignal): unknown {
  const failure = classifyAnthropicError(error, signal);
  switch (failure?.kind) {
    case 'timeout':
      return new RecipeReaderTimeoutError();
    case 'unavailable':
      return new RecipeReaderUnavailableError(failure.status);
    case 'rejected':
      return new RecipeReaderRequestError(
        failure.status,
        failure.providerErrorType,
        failure.providerMessage,
        failure.providerRequestId,
      );
    case undefined:
      return error;
  }
}
