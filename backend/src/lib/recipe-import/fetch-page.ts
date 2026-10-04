import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import {
  checkImportLink,
  isPublicAddress,
  type LinkRefusal,
} from './link-guard.ts';

// Fetches a linked recipe page for import, behind the SSRF guard (DEC-107).
// It runs before the reader is called and outside the seam (DEC-109). Every
// address it connects to is checked, through the DNS lookup it hands the
// socket and again once connected, so a second DNS answer can't slip past,
// and every redirect is checked again from the start.

export const PAGE_FETCH_TIMEOUT_MS = 15_000;
export const PAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PAGE_MAX_REDIRECTS = 5;

const USER_AGENT =
  'LoftysLarder/1.0 (recipe import; +https://loftys-larder.co.uk)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml']);

export interface FetchedPage {
  // Where the page was read from, after any redirects.
  url: URL;
  html: string;
  redirects: number;
}

export type PageFetcher = (
  url: URL,
  signal: AbortSignal,
) => Promise<FetchedPage>;

export class LinkNotAllowedError extends Error {
  constructor(readonly reason: LinkRefusal) {
    super('The link leads somewhere imports may not fetch');
    this.name = 'LinkNotAllowedError';
  }
}

export type PageUnreadableReason =
  | 'status'
  | 'not_html'
  | 'encoding'
  | 'too_large'
  | 'too_many_redirects'
  | 'timeout'
  | 'network';

export class PageUnreadableError extends Error {
  constructor(
    readonly reason: PageUnreadableReason,
    readonly status: number | null = null,
  ) {
    super('The page could not be read');
    this.name = 'PageUnreadableError';
  }
}

export interface PageFetcherOptions {
  // Tests only: resolve test host names, treat the test server's loopback
  // address as public, trust its certificate and reach its port, and
  // shorten the caps.
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  isAllowedAddress?: (address: string) => boolean;
  ca?: string;
  port?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

export function createPageFetcher(
  options: PageFetcherOptions = {},
): PageFetcher {
  const resolve = options.resolve ?? resolveHost;
  const isAllowed = options.isAllowedAddress ?? isPublicAddress;
  const timeoutMs = options.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? PAGE_MAX_BYTES;

  // Every answer must be allowed, and the socket connects only to these.
  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const first = addresses[0];
        if (
          !first ||
          !addresses.every((address) => isAllowed(address.address))
        ) {
          callback(new LinkNotAllowedError('address'), '', 0);
        } else if (lookupOptions.all) {
          callback(null, addresses);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => {
        callback(
          error instanceof Error ? error : new Error('DNS lookup failed'),
          '',
          0,
        );
      },
    );
  };

  function get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolveResponse, reject) => {
      const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
      // A literal address skips the lookup, so it's checked here.
      if (isIP(hostname) !== 0 && !isAllowed(hostname)) {
        reject(new LinkNotAllowedError('address'));
        return;
      }
      const request = https.request(
        {
          hostname,
          port: options.port ?? 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-GB,en;q=0.8',
          },
          agent: false,
          lookup,
          ca: options.ca,
          signal,
        },
        resolveResponse,
      );
      request.on('socket', (socket) => {
        socket.once('connect', () => {
          const remote = socket.remoteAddress;
          if (remote === undefined || !isAllowed(remote)) {
            request.destroy(new LinkNotAllowedError('address'));
          }
        });
      });
      request.on('error', reject);
      request.end();
    });
  }

  return async (start, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const fetchSignal = AbortSignal.any([signal, timeout]);
    try {
      let url = start;
      for (let redirects = 0; ; redirects += 1) {
        const response = await get(url, fetchSignal);
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (REDIRECT_STATUSES.has(status) && location !== undefined) {
          response.destroy();
          if (redirects === PAGE_MAX_REDIRECTS) {
            throw new PageUnreadableError('too_many_redirects', status);
          }
          url = nextUrl(location, url);
          continue;
        }
        if (status < 200 || status > 299) {
          response.destroy();
          throw new PageUnreadableError('status', status);
        }
        const body = await readBody(response, maxBytes, fetchSignal);
        return {
          url,
          html: decodeHtml(body, response.headers['content-type']),
          redirects,
        };
      }
    } catch (error) {
      if (
        error instanceof LinkNotAllowedError ||
        error instanceof PageUnreadableError
      ) {
        throw error;
      }
      // The caller's deadline, or the client gone: the caller reports it.
      if (signal.aborted) throw error;
      if (timeout.aborted) throw new PageUnreadableError('timeout');
      throw new PageUnreadableError('network');
    }
  };
}

function resolveHost(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

// A redirect is checked from the start, like the link the cook gave.
function nextUrl(location: string, from: URL): URL {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new PageUnreadableError('status');
  }
  const checked = checkImportLink(next);
  if (!checked.ok) throw new LinkNotAllowedError(checked.reason);
  return checked.url;
}

async function readBody(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const mediaType = (response.headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (mediaType && !HTML_MEDIA_TYPES.has(mediaType)) {
    response.destroy();
    throw new PageUnreadableError('not_html');
  }
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new PageUnreadableError('too_large');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  // Counted after decompression, so a small compressed body can't expand
  // past the cap.
  const collect = async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) throw new PageUnreadableError('too_large');
      chunks.push(chunk);
    }
  };
  const decompressor = createDecompressor(response.headers['content-encoding']);
  if (decompressor === undefined) {
    response.destroy();
    throw new PageUnreadableError('encoding');
  }
  if (decompressor === null) {
    await pipeline(response, collect, { signal });
  } else {
    await pipeline(response, decompressor, collect, { signal });
  }
  return Buffer.concat(chunks);
}

// Null for an uncompressed body, undefined for an encoding we didn't ask for.
function createDecompressor(
  contentEncoding: string | undefined,
): Transform | null | undefined {
  switch ((contentEncoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return null;
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return undefined;
  }
}

function decodeHtml(body: Buffer, contentType: string | undefined): string {
  const label =
    /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? '')?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(
      body.subarray(0, 4096).toString('latin1'),
    )?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
}
