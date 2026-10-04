import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CloudinaryDestroyError,
  createDestroyImage,
  importImageUrl,
  signUploadParams,
} from '../src/lib/cloudinary.ts';

const credentials = {
  cloudName: 'test-cloud',
  apiKey: 'test-key',
  apiSecret: 'super-secret',
};

const PUBLIC_ID = 'loftys-larder/imports/abc123';

function fakeFetch(response: Response) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url =
      input instanceof URL
        ? input.href
        : typeof input === 'string'
          ? input
          : input.url;
    requests.push({ url, init });
    return Promise.resolve(response);
  };
  return { fetchImpl, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('importImageUrl', () => {
  it('points at the JPEG rendition made at upload', () => {
    expect(importImageUrl('test-cloud', PUBLIC_ID)).toBe(
      'https://res.cloudinary.com/test-cloud/image/upload/c_limit,w_2576,h_2576,f_jpg,q_auto/loftys-larder/imports/abc123',
    );
  });
});

describe('createDestroyImage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts a signed destroy that also purges the CDN', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-04T12:00:00Z') });
    const { fetchImpl, requests } = fakeFetch(json({ result: 'ok' }));
    const signal = new AbortController().signal;

    await createDestroyImage(credentials, fetchImpl)(PUBLIC_ID, signal);

    const timestamp = Date.parse('2026-10-04T12:00:00Z') / 1000;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://api.cloudinary.com/v1_1/test-cloud/image/destroy',
    );
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.init?.signal).toBe(signal);
    const body = new URLSearchParams(
      requests[0]?.init?.body as URLSearchParams,
    );
    expect(Object.fromEntries(body)).toEqual({
      public_id: PUBLIC_ID,
      invalidate: 'true',
      timestamp: String(timestamp),
      api_key: 'test-key',
      signature: signUploadParams(
        { invalidate: true, public_id: PUBLIC_ID, timestamp },
        credentials.apiSecret,
      ),
    });
  });

  it('treats an image that is already gone as deleted', async () => {
    const { fetchImpl } = fakeFetch(json({ result: 'not found' }));
    await expect(
      createDestroyImage(credentials, fetchImpl)(
        PUBLIC_ID,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('throws on an error status, without Cloudinary’s message', async () => {
    const { fetchImpl } = fakeFetch(
      json({ error: { message: 'Invalid Signature abc' } }, 401),
    );
    const destroy = createDestroyImage(credentials, fetchImpl);
    const attempt = destroy(PUBLIC_ID, new AbortController().signal);

    await expect(attempt).rejects.toBeInstanceOf(CloudinaryDestroyError);
    await expect(attempt).rejects.toMatchObject({ detail: 'status 401' });
  });

  it('throws on any other result', async () => {
    const { fetchImpl } = fakeFetch(json({ result: 'error' }));
    await expect(
      createDestroyImage(credentials, fetchImpl)(
        PUBLIC_ID,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ detail: 'error' });
  });
});
