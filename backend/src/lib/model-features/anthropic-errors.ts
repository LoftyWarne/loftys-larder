import Anthropic from '@anthropic-ai/sdk';

// Sorts a failed Anthropic call for model features (cross-cutting #22). A
// helper, not a seam: each adapter turns the result into its own seam's
// errors.

export type AnthropicCallFailure =
  | { kind: 'timeout' }
  | { kind: 'unavailable'; status: number | null }
  // The provider refused the request itself, for a reason trying again can't
  // fix: a request it can't accept, a bad key or an unknown model.
  | {
      kind: 'rejected';
      status: number;
      // The provider's error type and validation message, and its id for
      // the request. The message says what was wrong with the request, so
      // it's logged; it isn't prompt or model text (DEC-104).
      providerErrorType: string | null;
      providerMessage: string | null;
      providerRequestId: string | null;
    };

// Client errors that mean the request was wrong, as opposed to a timeout
// (408), a conflict (409) or a rate limit (429), which can pass.
const TRANSIENT_CLIENT_STATUSES = new Set([408, 409, 429]);
const PROVIDER_MESSAGE_MAX_LENGTH = 500;

// Null for an error that didn't come from the call, which the caller rethrows.
export function classifyAnthropicError(
  error: unknown,
  signal: AbortSignal,
): AnthropicCallFailure | null {
  if (
    signal.aborted ||
    error instanceof Anthropic.APIUserAbortError ||
    error instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return { kind: 'timeout' };
  }
  if (error instanceof Anthropic.APIError) {
    const status: unknown = error.status;
    if (
      typeof status === 'number' &&
      status >= 400 &&
      status < 500 &&
      !TRANSIENT_CLIENT_STATUSES.has(status)
    ) {
      return {
        kind: 'rejected',
        status,
        providerErrorType: error.type,
        providerMessage: providerMessage(error.error),
        providerRequestId: error.requestID ?? null,
      };
    }
    return {
      kind: 'unavailable',
      status: typeof status === 'number' ? status : null,
    };
  }
  return null;
}

// The `error.message` of the provider's error body, if it has one.
function providerMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return null;
  }
  const detail: unknown = body.error;
  if (typeof detail !== 'object' || detail === null || !('message' in detail)) {
    return null;
  }
  return typeof detail.message === 'string'
    ? detail.message.slice(0, PROVIDER_MESSAGE_MAX_LENGTH)
    : null;
}
