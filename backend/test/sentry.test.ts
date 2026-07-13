import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { TRPCError } from '@trpc/server';
import {
  initSentry,
  registerSentryHooks,
  shouldReportToSentry,
} from '../src/plugins/sentry.ts';
import type { Config } from '../src/config.ts';

const authEnv = {
  BETTER_AUTH_SECRET: 'test-secret-thirty-two-characters-long!',
  BETTER_AUTH_URL: 'http://localhost:3000',
  RESEND_API_KEY: 're_test_key',
  MAGIC_LINK_FROM: 'magic@loftys-larder.co.uk',
  MAGIC_LINK_TRUSTED_ORIGIN: 'http://localhost:5173',
  MAGIC_LINK_ALLOWED_EMAILS: ['allowed@example.com'] as string[],
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET: 'test-secret',
} as const;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'silent',
    ALLOWED_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgres://lofty:lofty@localhost:5433/lofty_dev',
    AXIOM_ENDPOINT: 'https://api.axiom.co',
    SENTRY_TRACES_SAMPLE_RATE: 0,
    ...authEnv,
    ...overrides,
  };
}

describe('initSentry', () => {
  it('is a no-op when SENTRY_DSN is unset', () => {
    const init = vi.fn();
    const result = initSentry(makeConfig({ SENTRY_DSN: undefined }), { init });
    expect(result).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('warns via the supplied logger when the DSN is missing in production', () => {
    const init = vi.fn();
    const warn = vi.fn();
    const result = initSentry(
      makeConfig({
        NODE_ENV: 'production',
        ALLOWED_ORIGIN: undefined,
        SENTRY_DSN: undefined,
        AXIOM_TOKEN: 'token',
        AXIOM_DATASET: 'dataset',
      }),
      { init, logger: { warn } },
    );
    expect(result).toBe(false);
    expect(init).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when the DSN is missing in development', () => {
    const init = vi.fn();
    const warn = vi.fn();
    initSentry(makeConfig({ SENTRY_DSN: undefined }), {
      init,
      logger: { warn },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('initialises with DSN, beforeSend, and traces sampling at the configured rate', () => {
    const init = vi.fn();
    const result = initSentry(
      makeConfig({
        SENTRY_DSN: 'https://public@sentry.example/1',
        SENTRY_ENVIRONMENT: 'staging',
        SENTRY_TRACES_SAMPLE_RATE: 0.25,
      }),
      { init },
    );
    expect(result).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    const firstInitCall = init.mock.calls[0];
    if (!firstInitCall) throw new Error('Sentry.init was not invoked');
    const options = firstInitCall[0] as {
      dsn: string;
      environment: string;
      tracesSampleRate: number;
      beforeSend: (event: { extra: { email: string } }) => {
        extra: { email: string };
      };
    };
    expect(options.dsn).toBe('https://public@sentry.example/1');
    expect(options.environment).toBe('staging');
    expect(options.tracesSampleRate).toBe(0.25);
    // beforeSend must run scrubPii — assert by feeding an event with an
    // email and confirming it's redacted in the returned event.
    const scrubbed = options.beforeSend({ extra: { email: 'a@b.com' } });
    expect(scrubbed.extra.email).toBe('[redacted]');
  });

  it('defaults the environment to NODE_ENV when SENTRY_ENVIRONMENT is unset', () => {
    const init = vi.fn();
    initSentry(
      makeConfig({
        NODE_ENV: 'production',
        ALLOWED_ORIGIN: undefined,
        SENTRY_DSN: 'https://public@sentry.example/1',
        SENTRY_ENVIRONMENT: undefined,
        AXIOM_TOKEN: 'token',
        AXIOM_DATASET: 'dataset',
      }),
      { init },
    );
    const firstInitCall = init.mock.calls[0];
    if (!firstInitCall) throw new Error('Sentry.init was not invoked');
    const options = firstInitCall[0] as { environment: string };
    expect(options.environment).toBe('production');
  });
});

describe('registerSentryHooks', () => {
  it('tags the per-request isolation scope with reqId for each request', async () => {
    const captured: { reqId: string; scopeId: string }[] = [];
    let scopeCounter = 0;
    // Simulate an isolation scope per request by returning a fresh scope
    // each time the test app invokes getIsolationScope. The reqId tag goes
    // into the captured list so a follow-up request asserting a *different*
    // reqId proves the tag never leaks across scopes.
    const getIsolationScope = vi.fn(() => {
      const scopeId = `scope-${(++scopeCounter).toString()}`;
      return {
        setTag(key: string, value: string): void {
          if (key === 'reqId') captured.push({ reqId: value, scopeId });
        },
      };
    });
    const setupFastifyErrorHandler = vi.fn();

    const app = Fastify({ logger: false });
    app.get('/probe', (_req, reply) => {
      void reply.send({ ok: true });
    });
    registerSentryHooks(app, {
      getIsolationScope:
        getIsolationScope as unknown as typeof import('@sentry/node').getIsolationScope,
      setupFastifyErrorHandler:
        setupFastifyErrorHandler as unknown as typeof import('@sentry/node').setupFastifyErrorHandler,
    });

    const first = await app.inject({ method: 'GET', url: '/probe' });
    const second = await app.inject({ method: 'GET', url: '/probe' });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(setupFastifyErrorHandler).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(2);
    const [firstCapture, secondCapture] = captured;
    if (!firstCapture || !secondCapture) {
      throw new Error('expected two captured tags');
    }
    expect(firstCapture.reqId).not.toBe(secondCapture.reqId);
    expect(firstCapture.scopeId).not.toBe(secondCapture.scopeId);
  });
});

describe('shouldReportToSentry', () => {
  it('reports server-fault errors (HTTP >= 500)', () => {
    expect(
      shouldReportToSentry(new TRPCError({ code: 'INTERNAL_SERVER_ERROR' })),
    ).toBe(true);
  });

  it('reports a raw non-tRPC error wrapped as INTERNAL_SERVER_ERROR', () => {
    // tRPC wraps unrecognised throws into a 500 before onError sees them.
    expect(
      shouldReportToSentry(
        new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: new Error() }),
      ),
    ).toBe(true);
  });

  it.each([
    'BAD_REQUEST',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'TOO_MANY_REQUESTS',
  ] as const)('skips the client error %s (4xx)', (code) => {
    expect(shouldReportToSentry(new TRPCError({ code }))).toBe(false);
  });
});
