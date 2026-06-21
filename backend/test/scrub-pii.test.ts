import { describe, expect, it } from 'vitest';
import { scrubPii } from '../../shared/src/index.ts';

const REDACTED = '[redacted]';

describe('scrubPii', () => {
  it('strips the Cookie header from event.request.headers', () => {
    const event = {
      request: {
        headers: { Cookie: 'session=abc', 'X-Trace': 'ok' },
      },
    };
    scrubPii(event);
    expect(event.request.headers).toEqual({
      Cookie: REDACTED,
      'X-Trace': 'ok',
    });
  });

  it('matches header names case-insensitively', () => {
    const event = {
      request: {
        headers: {
          cookie: 'session=abc',
          AUTHORIZATION: 'Bearer xyz',
        },
      },
    };
    scrubPii(event);
    expect(event.request.headers.cookie).toBe(REDACTED);
    expect(event.request.headers.AUTHORIZATION).toBe(REDACTED);
  });

  it('recursively redacts any "email" key, regardless of case or depth', () => {
    const event = {
      extra: {
        email: 'top@example.com',
        user: {
          Email: 'mid@example.com',
          tags: [{ EMAIL: 'deep@example.com' }],
        },
      },
    };
    scrubPii(event);
    expect(event.extra.email).toBe(REDACTED);
    expect(event.extra.user.Email).toBe(REDACTED);
    const firstTag = event.extra.user.tags[0];
    if (!firstTag) throw new Error('expected at least one tag');
    expect(firstTag.EMAIL).toBe(REDACTED);
  });

  it('keeps the email key in place (only the value is masked)', () => {
    const event = { extra: { email: 'a@b.com' } };
    scrubPii(event);
    expect(Object.keys(event.extra)).toEqual(['email']);
  });

  it('leaves unrelated fields intact', () => {
    const event = {
      level: 'error',
      message: 'something broke',
      tags: { reqId: 'abc-123', component: 'planner' },
      breadcrumbs: [{ category: 'navigation', message: 'route change' }],
    };
    scrubPii(event);
    expect(event).toEqual({
      level: 'error',
      message: 'something broke',
      tags: { reqId: 'abc-123', component: 'planner' },
      breadcrumbs: [{ category: 'navigation', message: 'route change' }],
    });
  });

  it('returns the same reference (in-place mutation)', () => {
    const event = { extra: { email: 'a@b.com' } };
    const out = scrubPii(event);
    expect(out).toBe(event);
  });

  it('handles missing request / headers without throwing', () => {
    expect(() => scrubPii({})).not.toThrow();
    expect(() => scrubPii({ request: undefined })).not.toThrow();
    expect(() => scrubPii({ request: { headers: undefined } })).not.toThrow();
    expect(() => scrubPii({ request: { headers: null } })).not.toThrow();
  });

  it('terminates on cyclic structures', () => {
    interface CyclicNode {
      child?: CyclicNode;
      email?: string;
    }
    const event: CyclicNode & { extra: { node: CyclicNode } } = {
      extra: { node: {} },
    };
    event.extra.node.child = event.extra.node;
    event.extra.node.email = 'loop@example.com';
    expect(() => scrubPii(event)).not.toThrow();
    expect(event.extra.node.email).toBe(REDACTED);
  });
});
