import Anthropic from '@anthropic-ai/sdk';

import { recipeImportReadingSchema } from '../../../../shared/src/index.ts';
import type { ModelEffort } from '../../config.ts';
import { toStructuredOutputSchema } from '../model-features/structured-output-schema.ts';
import {
  buildRecipeReaderUserMessage,
  RECIPE_READER_SYSTEM_PROMPT,
} from './anthropic-prompt.ts';
import {
  RecipeReaderTimeoutError,
  RecipeReaderUnavailableError,
  type RecipeReader,
  type RecipeReaderOutcome,
} from './types.ts';

const READING_SCHEMA = toStructuredOutputSchema(recipeImportReadingSchema);

// Room for thinking plus a long proposal, and still under the SDK's limit for
// a non-streaming request.
const MAX_TOKENS = 16_000;

// A classifier refusal is re-run on the model Anthropic recommends for its
// category, inside the same call. A recipe tripping one is almost certainly
// a false positive. A refusal from the whole chain is still not a recipe.
const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

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
            betas: [REFUSAL_FALLBACK_BETA],
            fallbacks: 'default',
            output_config: {
              effort,
              format: { type: 'json_schema', schema: READING_SCHEMA },
            },
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
// that fails normalisation.
function toOutcome(text: string): RecipeReaderOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
  if (
    signal.aborted ||
    error instanceof Anthropic.APIUserAbortError ||
    error instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return new RecipeReaderTimeoutError();
  }
  if (error instanceof Anthropic.APIError) {
    const status: unknown = error.status;
    return new RecipeReaderUnavailableError(
      typeof status === 'number' ? status : null,
    );
  }
  return error;
}
