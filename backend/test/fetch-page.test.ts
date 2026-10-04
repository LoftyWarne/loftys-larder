import type { LookupAddress } from 'node:dns';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPageFetcher,
  LinkNotAllowedError,
  PAGE_MAX_REDIRECTS,
  PageUnreadableError,
  type PageFetcherOptions,
} from '../src/lib/recipe-import/fetch-page.ts';
import { isPublicAddress } from '../src/lib/recipe-import/link-guard.ts';

// A real HTTPS server on loopback, with a self-signed certificate for
// `recipe.test` and 127.0.0.1. DNS is faked, and the server's loopback address
// stands in for a public one, except where the real guard is under test.

const fixtures = new URL('./fixtures/page-fetch/', import.meta.url);
const cert = readFileSync(new URL('cert.pem', fixtures), 'utf8');
const key = readFileSync(new URL('key.pem', fixtures), 'utf8');

const PAGE = '<html><body><h1>Lentil Soup</h1></body></html>';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const SERVER: LookupAddress = { address: '127.0.0.1', family: 4 };
const HOSTS: Record<string, LookupAddress[]> = {
  'recipe.test': [SERVER],
  'private.test': [{ address: '10.0.0.1', family: 4 }],
  'mixed.test': [SERVER, { address: '192.168.1.1', family: 4 }],
  'loopback6.test': [{ address: '::1', family: 6 }],
};

function resolve(hostname: string): Promise<LookupAddress[]> {
  const addresses = HOSTS[hostname];
  return addresses
    ? Promise.resolve(addresses)
    : Promise.reject(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: 'ENOTFOUND',
        }),
      );
}

function serverOrPublic(address: string): boolean {
  return address === SERVER.address || isPublicAddress(address);
}

describe('fetchPage', () => {
  let server: Server;
  let port: number;
  let handler: Handler;
  let requests: string[];

  beforeAll(async () => {
    server = createServer({ cert, key }, (request, response) => {
      requests.push(`${request.headers.host ?? ''}${request.url ?? ''}`);
      handler(request, response);
    });
    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });

  beforeEach(() => {
    requests = [];
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
    };
  });

  function fetcher(options: PageFetcherOptions = {}) {
    return createPageFetcher({
      resolve,
      isAllowedAddress: serverOrPublic,
      ca: cert,
      port,
      ...options,
    });
  }

  function fetchUrl(
    url: string,
    options: PageFetcherOptions = {},
    signal = new AbortController().signal,
  ) {
    return fetcher(options)(new URL(url), signal);
  }

  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => {
        throw new Error('expected the fetch to fail');
      },
      (error: unknown) => error,
    );
  }

  it('fetches an https page and says who is asking', async () => {
    let userAgent: string | undefined;
    handler = (request, response) => {
      userAgent = request.headers['user-agent'];
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PAGE);
    };

    const page = await fetchUrl('https://recipe.test/soup?serves=4');

    expect(page).toEqual({
      url: new URL('https://recipe.test/soup?serves=4'),
      html: PAGE,
      redirects: 0,
    });
    expect(requests).toEqual([`recipe.test:${String(port)}/soup?serves=4`]);
    expect(userAgent).toMatch(/^LoftysLarder\//);
  });

  it('follows a redirect and reports where the page came from', async () => {
    handler = (request, response) => {
      if (request.url === '/old') {
        response.writeHead(301, { location: '/new' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PAGE);
    };

    const page = await fetchUrl('https://recipe.test/old');

    expect(page.url.href).toBe('https://recipe.test/new');
    expect(page.redirects).toBe(1);
  });

  it(`follows ${String(PAGE_MAX_REDIRECTS)} redirects and no more`, async () => {
    handler = (request, response) => {
      const hop = Number(request.url?.slice(1));
      if (hop < 10) {
        response.writeHead(302, { location: `/${String(hop + 1)}` });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PAGE);
    };

    const page = await fetchUrl(
      `https://recipe.test/${String(10 - PAGE_MAX_REDIRECTS)}`,
    );
    expect(page.redirects).toBe(PAGE_MAX_REDIRECTS);

    const error = await refusal(
      fetchUrl(`https://recipe.test/${String(9 - PAGE_MAX_REDIRECTS)}`),
    );
    expect(error).toBeInstanceOf(PageUnreadableError);
    expect(error).toMatchObject({ reason: 'too_many_redirects' });
  });

  describe('the guard', () => {
    it('refuses a public page that redirects to a private address, before connecting to it', async () => {
      handler = (_request, response) => {
        response.writeHead(302, { location: 'https://private.test/admin' });
        response.end();
      };

      const error = await refusal(fetchUrl('https://recipe.test/recipe'));

      expect(error).toBeInstanceOf(LinkNotAllowedError);
      expect(error).toMatchObject({ reason: 'address' });
      expect(requests).toEqual([`recipe.test:${String(port)}/recipe`]);
    });

    it.each([
      ['http', 'http://recipe.test/', 'not_https'],
      ['a private address', 'https://169.254.169.254/latest', 'address'],
      ['an IPv6 loopback address', 'https://[::1]/', 'address'],
      ['a password', 'https://cook:pw@recipe.test/', 'credentials'],
    ])('refuses a redirect to %s', async (_label, location, reason) => {
      handler = (_request, response) => {
        response.writeHead(307, { location });
        response.end();
      };

      const error = await refusal(fetchUrl('https://recipe.test/'));

      expect(error).toBeInstanceOf(LinkNotAllowedError);
      expect(error).toMatchObject({ reason });
      expect(requests).toHaveLength(1);
    });

    it('refuses a host when any of its DNS answers is private', async () => {
      const error = await refusal(fetchUrl('https://mixed.test/'));
      expect(error).toBeInstanceOf(LinkNotAllowedError);
      expect(requests).toHaveLength(0);
    });

    it('checks DNS again on every redirect, so a host that turns private is refused', async () => {
      let lookups = 0;
      const rebinding = (hostname: string) => {
        lookups += 1;
        return lookups === 1
          ? resolve(hostname)
          : Promise.resolve([{ address: '10.0.0.1', family: 4 }]);
      };
      handler = (_request, response) => {
        response.writeHead(302, { location: '/again' });
        response.end();
      };

      const error = await refusal(
        fetchUrl('https://recipe.test/', { resolve: rebinding }),
      );

      expect(error).toBeInstanceOf(LinkNotAllowedError);
      expect(lookups).toBe(2);
      expect(requests).toHaveLength(1);
    });

    it('checks the address it actually connected to, not only the DNS answer', async () => {
      const checked: string[] = [];
      const allowOnce = (address: string) => {
        checked.push(address);
        return checked.length === 1;
      };

      const error = await refusal(
        fetchUrl('https://recipe.test/', { isAllowedAddress: allowOnce }),
      );

      expect(error).toBeInstanceOf(LinkNotAllowedError);
      expect(checked).toEqual([SERVER.address, SERVER.address]);
      expect(requests).toHaveLength(0);
    });

    it.each([
      ['a host that resolves to loopback', 'https://recipe.test/'],
      ['a host that resolves to IPv6 loopback', 'https://loopback6.test/'],
      ['a host that resolves to a private address', 'https://private.test/'],
      ['a loopback address', 'https://127.0.0.1/'],
      ['loopback written as a number', 'https://2130706433/'],
      ['a link-local address', 'https://169.254.169.254/'],
      ['an IPv6 loopback address', 'https://[::1]/'],
      ['an IPv4-mapped loopback address', 'https://[::ffff:127.0.0.1]/'],
    ])('refuses %s with the real guard', async (_label, url) => {
      const error = await refusal(
        createPageFetcher({ resolve, ca: cert, port })(
          new URL(url),
          new AbortController().signal,
        ),
      );
      expect(error).toBeInstanceOf(LinkNotAllowedError);
      expect(requests).toHaveLength(0);
    });
  });

  describe('unreadable pages', () => {
    it('reports a refused fetch with its status', async () => {
      handler = (_request, response) => {
        response.writeHead(403, { 'content-type': 'text/html' });
        response.end('Forbidden');
      };
      const error = await refusal(fetchUrl('https://recipe.test/'));
      expect(error).toBeInstanceOf(PageUnreadableError);
      expect(error).toMatchObject({ reason: 'status', status: 403 });
    });

    it("reports a page that isn't HTML", async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/pdf' });
        response.end('%PDF-1.7');
      };
      const error = await refusal(fetchUrl('https://recipe.test/'));
      expect(error).toMatchObject({ reason: 'not_html' });
    });

    it('reports a page declared larger than the cap without reading it', async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('x'.repeat(2_000));
      };
      const error = await refusal(
        fetchUrl('https://recipe.test/', { maxBytes: 1_000 }),
      );
      expect(error).toMatchObject({ reason: 'too_large' });
    });

    it('stops reading a streamed page once it passes the cap', async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        for (let chunk = 0; chunk < 20; chunk += 1) {
          response.write('x'.repeat(500));
        }
        response.end();
      };
      const error = await refusal(
        fetchUrl('https://recipe.test/', { maxBytes: 1_000 }),
      );
      expect(error).toMatchObject({ reason: 'too_large' });
    });

    it('counts the size after decompression', async () => {
      handler = (_request, response) => {
        response.writeHead(200, {
          'content-type': 'text/html',
          'content-encoding': 'gzip',
        });
        response.end(gzipSync('x'.repeat(100_000)));
      };
      const error = await refusal(
        fetchUrl('https://recipe.test/', { maxBytes: 10_000 }),
      );
      expect(error).toMatchObject({ reason: 'too_large' });
    });

    it('gives up on a page slower than the time cap', async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<html>');
      };
      const error = await refusal(
        fetchUrl('https://recipe.test/', { timeoutMs: 200 }),
      );
      expect(error).toBeInstanceOf(PageUnreadableError);
      expect(error).toMatchObject({ reason: 'timeout' });
    });

    it.each([
      ['a host that does not exist', 'https://missing.test/', {}],
      ['a certificate it does not trust', 'https://recipe.test/', { ca: '' }],
    ])('reports %s', async (_label, url, options) => {
      const error = await refusal(fetchUrl(url, options));
      expect(error).toBeInstanceOf(PageUnreadableError);
      expect(error).toMatchObject({ reason: 'network' });
    });

    it("leaves the caller's own abort to the caller", async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<html>');
      };
      const controller = new AbortController();
      const pending = refusal(
        fetchUrl('https://recipe.test/', {}, controller.signal),
      );
      setTimeout(() => {
        controller.abort();
      }, 50);

      const error = await pending;
      expect(error).not.toBeInstanceOf(PageUnreadableError);
      expect(error).not.toBeInstanceOf(LinkNotAllowedError);
    });
  });

  describe('decoding', () => {
    it.each([
      ['gzip', gzipSync(PAGE)],
      ['br', brotliCompressSync(PAGE)],
    ])('decompresses %s', async (encoding, body) => {
      handler = (_request, response) => {
        response.writeHead(200, {
          'content-type': 'text/html',
          'content-encoding': encoding,
        });
        response.end(body);
      };
      expect((await fetchUrl('https://recipe.test/')).html).toBe(PAGE);
    });

    it('reads the charset from the header, then from the page', async () => {
      // 0xBD is ½ in windows-1252.
      const latin = Buffer.concat([
        Buffer.from('<p>'),
        Buffer.from([0xbd]),
        Buffer.from(' cup</p>'),
      ]);
      handler = (request, response) => {
        if (request.url === '/header') {
          response.writeHead(200, {
            'content-type': 'text/html; charset=windows-1252',
          });
          response.end(latin);
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          Buffer.concat([Buffer.from('<meta charset="windows-1252">'), latin]),
        );
      };

      expect((await fetchUrl('https://recipe.test/header')).html).toBe(
        '<p>½ cup</p>',
      );
      expect((await fetchUrl('https://recipe.test/meta')).html).toBe(
        '<meta charset="windows-1252"><p>½ cup</p>',
      );
    });
  });
});
