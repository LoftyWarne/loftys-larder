import Anthropic from '@anthropic-ai/sdk';

// Shared Anthropic client setup for model features (cross-cutting #22). A
// helper, not a seam: each feature's adapter owns its prompt and request.

export interface AnthropicClientOptions {
  apiKey: string;
  // Tests fake the SDK's HTTP layer here.
  fetch?: typeof fetch;
}

export function createAnthropicClient(
  options: AnthropicClientOptions,
): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    // One retry for a dropped connection or an overloaded provider. Callers
    // pass an AbortSignal that bounds the attempt and its retry together.
    maxRetries: 1,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
