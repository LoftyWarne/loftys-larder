import * as Sentry from '@sentry/node';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { scrubPii } from '../../../shared/src/index.ts';
import type { Config } from '../config.ts';

// Backend Sentry wiring (DEC-76 / FEAT-45). Init is best-effort: a missing
// DSN no-ops the SDK without aborting boot — Sentry is observability, not
// a critical path (DEC-75's "fail fast" applied to Axiom because it's the
// only structured-log destination; Sentry has no equivalent role).

export interface InitSentryOptions {
  // Injectable for tests so we can assert init was called without touching
  // the real SDK; defaults to the imported `Sentry.init`.
  init?: typeof Sentry.init;
  // Optional logger to surface the no-op-warning in prod without reaching
  // for `console.log` (FEAT-03 / AGENTS.md trap).
  logger?: Pick<FastifyBaseLogger, 'warn'>;
}

export function initSentry(
  config: Config,
  options: InitSentryOptions = {},
): boolean {
  if (!config.SENTRY_DSN) {
    if (config.NODE_ENV === 'production') {
      options.logger?.warn(
        'SENTRY_DSN unset in production — error tracking disabled.',
      );
    }
    return false;
  }
  const init = options.init ?? Sentry.init;
  init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    // Session replay isn't a Node SDK feature; the disable is structurally
    // true server-side. Re-asserted in the frontend init (DEC-76).
    beforeSend: (event) => scrubPii(event),
    beforeBreadcrumb: (breadcrumb) => scrubPii(breadcrumb),
  });
  return true;
}

export interface RegisterSentryHooksOptions {
  // Injectable for tests: the per-request reqId tag setter and the Fastify
  // error handler integration are both swappable so the hook can be asserted
  // without booting the real SDK.
  getIsolationScope?: typeof Sentry.getIsolationScope;
  setupFastifyErrorHandler?: typeof Sentry.setupFastifyErrorHandler;
}

export function registerSentryHooks(
  app: FastifyInstance,
  options: RegisterSentryHooksOptions = {},
): void {
  const getIsolationScope =
    options.getIsolationScope ?? Sentry.getIsolationScope;
  const setupFastifyErrorHandler =
    options.setupFastifyErrorHandler ?? Sentry.setupFastifyErrorHandler;

  // Sentry's HTTP integration (loaded by default in `Sentry.init`) creates a
  // per-request isolation scope via OpenTelemetry context before Fastify's
  // lifecycle starts; `onRequest` is the earliest Fastify hook, so the
  // request-bound scope already exists by the time we tag it.
  app.addHook('onRequest', (req, _reply, done) => {
    getIsolationScope().setTag('reqId', req.id);
    done();
  });

  setupFastifyErrorHandler(app);
}

export { captureException } from '@sentry/node';
