import * as Sentry from '@sentry/react';
import { scrubPii } from '@loftys-larder/shared';

// Frontend Sentry wiring (DEC-76 / FEAT-45). Init is best-effort and reads
// the DSN from Vite's build-time env: an unset `VITE_SENTRY_DSN` no-ops the
// SDK without affecting the rendered app. Session replay is explicitly
// disabled — the non-goal in docs/non-goals.md ("Session replay in Sentry")
// is the source of truth here.

export interface InitSentryOptions {
  // Injectable for tests so we can assert init was called without touching
  // the real SDK; defaults to the imported `Sentry.init`.
  init?: typeof Sentry.init;
  // Override the DSN source (defaults to `import.meta.env.VITE_SENTRY_DSN`).
  dsn?: string;
  environment?: string;
}

function firstNonEmpty(...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return 'development';
}

export function initSentry(options: InitSentryOptions = {}): boolean {
  const dsn = options.dsn ?? import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return false;
  const init = options.init ?? Sentry.init;
  // Empty-string env vars (e.g. `VITE_SENTRY_ENVIRONMENT=` in .env) should
  // fall through to the next default — `??` only handles nullish, so use a
  // small helper that treats empty strings as absent.
  init({
    dsn,
    environment: firstNonEmpty(
      options.environment,
      import.meta.env.VITE_SENTRY_ENVIRONMENT,
      import.meta.env.MODE,
    ),
    // Replay is off by design — see docs/non-goals.md. Not passing the
    // `replayIntegration` keeps it out of the bundle entirely.
    integrations: [],
    tracesSampleRate: 0,
    beforeSend: (event) => scrubPii(event),
    beforeBreadcrumb: (breadcrumb) => scrubPii(breadcrumb),
  });
  return true;
}

export { captureException } from '@sentry/react';
