// PII scrubber used by both Sentry SDKs' `beforeSend` hooks (DEC-76).
// Pure, in-place, structural — runs on every captured event so it has to
// stay cheap and free of new allocations beyond the redacted string.
//
// Two contracts:
// 1. Strip `Cookie` and `Authorization` from `event.request.headers`
//    regardless of case (HTTP header names are case-insensitive; Sentry's
//    normaliser is not).
// 2. Recursively replace the value of any object key matching /^email$/i
//    anywhere in the event tree with `[redacted]`. The key survives — only
//    the value is masked — so downstream tooling sees the same shape.
//
// Generic over the input type so Sentry's `ErrorEvent` / `Breadcrumb` (and
// any other beforeSend-shape) survive the call with their declared types
// intact; the function narrows structurally inside.

const REDACTED = '[redacted]' as const;
const SENSITIVE_HEADERS = new Set(['cookie', 'authorization']);
const EMAIL_KEY_PATTERN = /^email$/i;

export type ScrubbableHeaders = Record<string, unknown>;

export type ScrubbableRequest = Record<string, unknown> & {
  headers?: ScrubbableHeaders | null;
};

export type ScrubbableEvent = Record<string, unknown> & {
  request?: ScrubbableRequest | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function scrubHeaders(headers: unknown): void {
  if (!isRecord(headers)) return;
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      headers[key] = REDACTED;
    }
  }
}

function scrubEmails(node: unknown, seen: WeakSet<object>): void {
  if (!isRecord(node)) return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      scrubEmails(item, seen);
    }
    return;
  }
  for (const key of Object.keys(node)) {
    if (EMAIL_KEY_PATTERN.test(key)) {
      node[key] = REDACTED;
      continue;
    }
    scrubEmails(node[key], seen);
  }
}

export function scrubPii<T>(event: T): T {
  if (!isRecord(event)) return event;
  const request = event.request;
  if (isRecord(request)) {
    scrubHeaders(request.headers);
  }
  scrubEmails(event, new WeakSet());
  return event;
}
