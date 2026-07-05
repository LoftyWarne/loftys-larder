import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { buildApp, type BuildAppOptions } from '../src/server.ts';
import type { Config } from '../src/config.ts';
import { buildCspDirectives } from '../src/plugins/security.ts';
import * as schema from '../src/db/schema/index.ts';

const fakeDbPool = new pg.Pool({
  max: 1,
  connectionString: 'postgres://x:x@127.0.0.1:1/x',
});
const fakeDb: NodePgDatabase<typeof schema> = drizzle(fakeDbPool, {
  schema,
  casing: 'snake_case',
});

const buildOptions: BuildAppOptions = {
  db: fakeDb,
  sendMagicLink: () => Promise.resolve(),
};

const baseEnv = {
  BETTER_AUTH_SECRET: 'test-secret-thirty-two-characters-long!',
  BETTER_AUTH_URL: 'http://localhost:3000',
  RESEND_API_KEY: 're_test_key',
  MAGIC_LINK_FROM: 'magic@loftys-larder.co.uk',
  MAGIC_LINK_TRUSTED_ORIGIN: 'http://localhost:5173',
  MAGIC_LINK_ALLOWED_EMAILS: ['allowed@example.com'] as string[],
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET: 'test-secret',
};

const devConfig: Config = {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  ALLOWED_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://lofty:lofty@localhost:5433/lofty_dev',
  AXIOM_ENDPOINT: 'https://api.axiom.co',
  SENTRY_TRACES_SAMPLE_RATE: 0,
  ...baseEnv,
};

const prodConfig: Config = {
  ...devConfig,
  NODE_ENV: 'production',
  ALLOWED_ORIGIN: undefined,
  AXIOM_TOKEN: 'test-axiom-token',
  AXIOM_DATASET: 'test-dataset',
};

function parseCsp(
  header: string | string[] | undefined,
): Map<string, string[]> {
  const value = Array.isArray(header) ? header.join('; ') : (header ?? '');
  const directives = new Map<string, string[]>();
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...tokens] = trimmed.split(/\s+/);
    if (!name) continue;
    directives.set(name.toLowerCase(), tokens);
  }
  return directives;
}

describe('CSP policy', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('sets the Content-Security-Policy header on responses', async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.headers['content-security-policy']).toBeDefined();
  });

  it('allows Cloudinary and data: URIs in img-src', async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = parseCsp(response.headers['content-security-policy']);
    const imgSrc = csp.get('img-src') ?? [];
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain('https://res.cloudinary.com');
    expect(imgSrc).toContain('data:');
  });

  it('includes the Sentry browser ingest origin in connect-src when configured', async () => {
    app = await buildApp(
      {
        ...devConfig,
        SENTRY_BROWSER_INGEST_ORIGIN: 'https://o123.ingest.sentry.io',
      },
      buildOptions,
    );
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = parseCsp(response.headers['content-security-policy']);
    const connectSrc = csp.get('connect-src') ?? [];
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain('https://o123.ingest.sentry.io');
  });

  it('limits connect-src to self and Cloudinary when Sentry ingest is unset', async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = parseCsp(response.headers['content-security-policy']);
    expect(csp.get('connect-src')).toEqual([
      "'self'",
      'https://api.cloudinary.com',
    ]);
  });

  it('allows the Cloudinary upload host in connect-src', async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = parseCsp(response.headers['content-security-policy']);
    expect(csp.get('connect-src') ?? []).toContain(
      'https://api.cloudinary.com',
    );
  });

  it("keeps script-src strict (no 'unsafe-inline')", async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = parseCsp(response.headers['content-security-policy']);
    const scriptSrc = csp.get('script-src') ?? [];
    expect(scriptSrc).toEqual(["'self'"]);
  });

  it("permits 'unsafe-inline' in style-src for shadcn/Radix inline styles", async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = parseCsp(response.headers['content-security-policy']);
    const styleSrc = csp.get('style-src') ?? [];
    expect(styleSrc).toContain("'self'");
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it("sets frame-ancestors 'none' with X-Frame-Options as backup", async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = parseCsp(response.headers['content-security-policy']);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it("falls back to 'self' for unlisted fetch types via default-src", async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = parseCsp(response.headers['content-security-policy']);
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
  });

  it('sets HSTS in production', async () => {
    app = await buildApp(prodConfig, buildOptions);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const hsts = response.headers['strict-transport-security'];
    expect(typeof hsts).toBe('string');
    expect(hsts).toMatch(/max-age=\d+/);
  });

  describe('buildCspDirectives', () => {
    it('omits Sentry ingest entirely when unset', () => {
      const directives = buildCspDirectives(devConfig);
      expect(Array.from(directives.connectSrc)).toEqual([
        "'self'",
        'https://api.cloudinary.com',
      ]);
    });
  });
});
