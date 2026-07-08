import { describe, expect, it } from 'vitest';
import { trpcNotFoundBody } from '../src/trpc/not-found.ts';

describe('trpcNotFoundBody', () => {
  it('produces an envelope the tRPC batch client can decode', () => {
    const body = trpcNotFoundBody(
      'GET',
      '/api/trpc/foo.bar?batch=1&input=%7B%7D',
    );
    // The batch client only accepts an error payload whose `code` is numeric;
    // a string (Fastify's default) throws "Unable to transform response...".
    expect(typeof body.error.code).toBe('number');
    expect(body.error.code).toBe(-32004);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.data.code).toBe('NOT_FOUND');
    expect(body.error.data.httpStatus).toBe(404);
  });

  it('strips the query string from the echoed path', () => {
    const body = trpcNotFoundBody('GET', '/api/trpc/foo?input=secret');
    expect(body.error.data.path).toBe('/api/trpc/foo');
    expect(body.error.message).not.toContain('secret');
  });

  it('bounds the echoed path so a pathological URL cannot bloat the body', () => {
    const body = trpcNotFoundBody('GET', `/api/trpc/${'a'.repeat(1000)}`);
    expect(body.error.data.path.length).toBeLessThanOrEqual(256);
  });
});
