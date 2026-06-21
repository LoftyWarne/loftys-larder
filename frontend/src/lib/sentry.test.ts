import { afterEach, describe, expect, it, vi } from 'vitest';
import { initSentry } from './sentry.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('initSentry (frontend)', () => {
  it('no-ops when VITE_SENTRY_DSN is unset', () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    const init = vi.fn();
    expect(initSentry({ init })).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('initialises with the DSN and disables session replay', () => {
    const init = vi.fn();
    const result = initSentry({
      init,
      dsn: 'https://public@sentry.example/2',
      environment: 'production',
    });
    expect(result).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    const firstInitCall = init.mock.calls[0];
    if (!firstInitCall) throw new Error('Sentry.init was not invoked');
    const options = firstInitCall[0] as {
      dsn: string;
      environment: string;
      tracesSampleRate: number;
      integrations: unknown[];
      beforeSend: (event: { extra: { email: string } }) => {
        extra: { email: string };
      };
    };
    expect(options.dsn).toBe('https://public@sentry.example/2');
    expect(options.environment).toBe('production');
    expect(options.tracesSampleRate).toBe(0);
    // Empty `integrations` keeps replay (and tracing) out of the bundle —
    // the contract DEC-76 / docs/non-goals.md asks for.
    expect(options.integrations).toEqual([]);
    const scrubbed = options.beforeSend({ extra: { email: 'a@b.com' } });
    expect(scrubbed.extra.email).toBe('[redacted]');
  });

  it('falls back to import.meta.env.MODE when no environment is supplied', () => {
    vi.stubEnv('VITE_SENTRY_ENVIRONMENT', '');
    vi.stubEnv('MODE', 'test');
    const init = vi.fn();
    initSentry({ init, dsn: 'https://public@sentry.example/3' });
    const firstInitCall = init.mock.calls[0];
    if (!firstInitCall) throw new Error('Sentry.init was not invoked');
    const options = firstInitCall[0] as { environment: string };
    // Vitest's MODE is 'test' by default.
    expect(['test', 'development']).toContain(options.environment);
  });
});
