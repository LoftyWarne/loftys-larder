import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signUploadParams } from '../src/lib/cloudinary.ts';

function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

describe('signUploadParams', () => {
  const secret = 'abcd';

  it('SHA-1s the alphabetised k=v join with the secret appended', () => {
    const signature = signUploadParams(
      { timestamp: 1234567890, folder: 'recipes' },
      secret,
    );
    expect(signature).toBe(
      sha1Hex(`folder=recipes&timestamp=1234567890${secret}`),
    );
  });

  it('orders keys by sort, not by insertion order', () => {
    const a = signUploadParams({ z: '1', a: '2', m: '3' }, secret);
    const b = signUploadParams({ m: '3', a: '2', z: '1' }, secret);
    expect(a).toBe(b);
    expect(a).toBe(sha1Hex(`a=2&m=3&z=1${secret}`));
  });

  it('excludes file, cloud_name, resource_type, api_key, and signature', () => {
    const signature = signUploadParams(
      {
        timestamp: 1,
        folder: 'recipes',
        file: '@/tmp/photo.jpg',
        cloud_name: 'test',
        resource_type: 'image',
        api_key: '999',
        signature: 'ignored',
      },
      secret,
    );
    expect(signature).toBe(sha1Hex(`folder=recipes&timestamp=1${secret}`));
  });

  it('appends the secret exactly once at the end', () => {
    const signature = signUploadParams({ timestamp: 1 }, secret);
    expect(signature).toBe(sha1Hex(`timestamp=1${secret}`));
    expect(signature).not.toBe(sha1Hex(`${secret}timestamp=1`));
    expect(signature).not.toBe(sha1Hex(`${secret}timestamp=1${secret}`));
  });

  it('produces a 40-char hex digest', () => {
    const signature = signUploadParams({ timestamp: 1 }, secret);
    expect(signature).toMatch(/^[a-f0-9]{40}$/);
  });

  it('serialises numbers and booleans via String()', () => {
    const signature = signUploadParams(
      { invalidate: true, max_file_size: 5_242_880 },
      secret,
    );
    expect(signature).toBe(
      sha1Hex(`invalidate=true&max_file_size=5242880${secret}`),
    );
  });
});
