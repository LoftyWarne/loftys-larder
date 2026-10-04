import { createHash } from 'node:crypto';

import { RECIPE_IMPORT_IMAGE_EAGER_TRANSFORMATION } from '../../../shared/src/index.ts';

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

// Cloudinary's signature rule, for uploads and destroy calls alike: take
// every parameter that will be POSTed *except* `file`, `cloud_name`,
// `resource_type`, `api_key`, and `signature` itself; sort the remaining keys
// alphabetically; join as `k=v&k=v`; append the API secret directly (no
// separator); SHA-1 hex digest.
// Reference: https://cloudinary.com/documentation/signatures
const UNSIGNED_PARAMS = new Set([
  'file',
  'cloud_name',
  'resource_type',
  'api_key',
  'signature',
]);

export type SignableValue = string | number | boolean;

export function signUploadParams(
  params: Record<string, SignableValue>,
  apiSecret: string,
): string {
  const serialised = Object.keys(params)
    .filter((key) => !UNSIGNED_PARAMS.has(key))
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('&');

  return createHash('sha1').update(`${serialised}${apiSecret}`).digest('hex');
}

// The import rendition made at upload (DEC-107): what the reader is sent and
// what the cook sees. The transformation sets the format, so there's no
// extension.
export function importImageUrl(cloudName: string, publicId: string): string {
  return `https://res.cloudinary.com/${cloudName}/image/upload/${RECIPE_IMPORT_IMAGE_EAGER_TRANSFORMATION}/${publicId}`;
}

// Deletes one image and purges its cached copies from Cloudinary's CDN.
export type DestroyImage = (
  publicId: string,
  signal: AbortSignal,
) => Promise<void>;

export class CloudinaryDestroyError extends Error {
  constructor(
    // Metadata only: an HTTP status or Cloudinary's result code.
    readonly detail: string,
  ) {
    super(`Cloudinary didn't delete the image: ${detail}`);
    this.name = 'CloudinaryDestroyError';
  }
}

export function createDestroyImage(
  credentials: CloudinaryCredentials,
  fetchImpl: typeof fetch = fetch,
): DestroyImage {
  return async (publicId, signal) => {
    // Unix seconds, a protocol field rather than a domain date, as for
    // uploads (`dateUtils` doesn't apply).
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signUploadParams(
      { invalidate: true, public_id: publicId, timestamp },
      credentials.apiSecret,
    );
    const response = await fetchImpl(
      `https://api.cloudinary.com/v1_1/${credentials.cloudName}/image/destroy`,
      {
        method: 'POST',
        body: new URLSearchParams({
          public_id: publicId,
          invalidate: 'true',
          timestamp: String(timestamp),
          api_key: credentials.apiKey,
          signature,
        }),
        signal,
      },
    );
    if (!response.ok) {
      throw new CloudinaryDestroyError(`status ${String(response.status)}`);
    }
    const payload = (await response.json()) as { result?: unknown };
    // "not found" means it's already gone, which is what was wanted.
    if (payload.result !== 'ok' && payload.result !== 'not found') {
      throw new CloudinaryDestroyError(
        typeof payload.result === 'string' ? payload.result : 'no result',
      );
    }
  };
}
