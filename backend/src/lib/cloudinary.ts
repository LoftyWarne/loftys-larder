import { createHash } from 'node:crypto';

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

// Cloudinary's signature rule: take every upload parameter the client will
// POST *except* `file`, `cloud_name`, `resource_type`, `api_key`, and
// `signature` itself; sort the remaining keys alphabetically; join as
// `k=v&k=v`; append the API secret directly (no separator); SHA-1 hex digest.
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
