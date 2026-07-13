import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createAxiomDestination } from '../src/plugins/axiom-destination.ts';
import { buildLoggerBundle } from '../src/plugins/logger.ts';
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
    LOG_LEVEL: 'info',
    ALLOWED_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgres://lofty:lofty@localhost:5433/lofty_dev',
    AXIOM_ENDPOINT: 'https://api.axiom.co',
    SENTRY_TRACES_SAMPLE_RATE: 0,
    ...authEnv,
    ...overrides,
  };
}

function collectStream(): { stream: PassThrough; lines: () => string[] } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    stream,
    lines: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0),
  };
}

function okFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('buildLoggerBundle', () => {
  it('does not construct an Axiom destination in development', () => {
    const { axiom } = buildLoggerBundle(
      makeConfig({ NODE_ENV: 'development' }),
    );
    expect(axiom).toBeNull();
  });

  it('does not construct an Axiom destination in test', () => {
    const { axiom } = buildLoggerBundle(makeConfig({ NODE_ENV: 'test' }));
    expect(axiom).toBeNull();
  });

  it('wires an Axiom destination in production and posts NDJSON to the ingest endpoint', async () => {
    const fetchSpy = okFetch();
    const { stream: stdout, lines } = collectStream();
    const { logger, axiom } = buildLoggerBundle(
      makeConfig({
        NODE_ENV: 'production',
        ALLOWED_ORIGIN: undefined,
        AXIOM_TOKEN: 'xaat-test',
        AXIOM_DATASET: 'lofty-prod',
      }),
      { fetchImpl: fetchSpy, stdout },
    );

    if (!axiom) throw new Error('expected Axiom destination in production');
    logger.info({ reqId: 'abc-123' }, 'request completed');
    await axiom.end();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    expect(urlOf(call[0])).toBe(
      'https://api.axiom.co/v1/datasets/lofty-prod/ingest',
    );
    const init = call[1];
    if (!init) throw new Error('fetch was called without init');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer xaat-test');
    expect(headers['content-type']).toBe('application/x-ndjson');
    const body = init.body;
    if (typeof body !== 'string') throw new Error('expected string body');
    const entry = JSON.parse(body.trimEnd()) as {
      reqId: string;
      env: string;
      msg: string;
    };
    expect(entry.reqId).toBe('abc-123');
    expect(entry.env).toBe('production');
    expect(entry.msg).toBe('request completed');

    // Same entry mirrored to stdout (so it stays visible in Fly logs even if
    // Axiom is unreachable).
    const stdoutLines = lines();
    expect(stdoutLines).toHaveLength(1);
    expect(JSON.parse(stdoutLines[0] ?? '{}')).toMatchObject({
      reqId: 'abc-123',
      env: 'production',
    });
  });

  it('reports an Axiom ingest failure to the error stream instead of dropping it silently', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    const { stream: stdout } = collectStream();
    const { stream: errorStream, lines: errorLines } = collectStream();
    const { logger, axiom } = buildLoggerBundle(
      makeConfig({
        NODE_ENV: 'production',
        ALLOWED_ORIGIN: undefined,
        AXIOM_TOKEN: 'xaat-bad',
        AXIOM_DATASET: 'lofty-prod',
      }),
      { fetchImpl: fetchSpy, stdout, errorStream },
    );

    if (!axiom) throw new Error('expected Axiom destination in production');
    logger.info({ reqId: 'abc-123' }, 'request completed');
    await axiom.end();

    const reported = errorLines().map((line) => JSON.parse(line) as unknown);
    expect(reported).toContainEqual(
      expect.objectContaining({ msg: 'axiom ingest failed' }),
    );
  });
});

describe('createAxiomDestination', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes the buffer once the batch-size threshold is hit', async () => {
    const fetchSpy = okFetch();
    const dest = createAxiomDestination({
      token: 't',
      dataset: 'd',
      maxBatchSize: 2,
      fetchImpl: fetchSpy,
    });
    dest.write('{"msg":"a"}\n');
    expect(fetchSpy).not.toHaveBeenCalled();
    dest.write('{"msg":"b"}\n');
    await dest.end();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    expect(call[1]?.body).toBe('{"msg":"a"}\n{"msg":"b"}\n');
  });

  it('flushes on the interval timer when below batch size', async () => {
    vi.useFakeTimers();
    const fetchSpy = okFetch();
    const dest = createAxiomDestination({
      token: 't',
      dataset: 'd',
      flushIntervalMs: 50,
      maxBatchSize: 100,
      fetchImpl: fetchSpy,
    });
    dest.write('{"msg":"a"}\n');
    expect(fetchSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows fetch errors via the onError callback so logging never crashes the app', async () => {
    const onError = vi.fn<(err: unknown) => void>();
    const dest = createAxiomDestination({
      token: 't',
      dataset: 'd',
      maxBatchSize: 1,
      fetchImpl: () => {
        throw new Error('network down');
      },
      onError,
    });
    dest.write('{"msg":"a"}\n');
    await dest.end();
    expect(onError).toHaveBeenCalledTimes(1);
    const firstCall = onError.mock.calls[0];
    if (!firstCall) throw new Error('onError was not called');
    const err = firstCall[0];
    if (!(err instanceof Error)) throw new Error('expected Error instance');
    expect(err.message).toBe('network down');
  });

  it('reports non-2xx responses via the onError callback', async () => {
    const onError = vi.fn<(err: unknown) => void>();
    const dest = createAxiomDestination({
      token: 't',
      dataset: 'd',
      maxBatchSize: 1,
      fetchImpl: () => Promise.resolve(new Response(null, { status: 401 })),
      onError,
    });
    dest.write('{"msg":"a"}\n');
    await dest.end();
    expect(onError).toHaveBeenCalledTimes(1);
    const firstCall = onError.mock.calls[0];
    if (!firstCall) throw new Error('onError was not called');
    const err = firstCall[0];
    if (!(err instanceof Error)) throw new Error('expected Error instance');
    expect(err.message).toMatch(/401/);
  });

  it('url-encodes the dataset name', async () => {
    const fetchSpy = okFetch();
    const dest = createAxiomDestination({
      token: 't',
      dataset: 'lofty prod/eu',
      maxBatchSize: 1,
      fetchImpl: fetchSpy,
    });
    dest.write('{"msg":"a"}\n');
    await dest.end();
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    expect(urlOf(call[0])).toBe(
      'https://api.axiom.co/v1/datasets/lofty%20prod%2Feu/ingest',
    );
  });
});
