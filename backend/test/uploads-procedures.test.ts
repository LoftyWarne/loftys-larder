import { describe, expect, it } from 'vitest';

import {
  RECIPE_IMAGE_ALLOWED_FORMATS,
  RECIPE_IMAGE_EAGER_TRANSFORMATION,
  RECIPE_IMAGE_FOLDER,
  RECIPE_IMAGE_MAX_FILE_SIZE,
} from '../../shared/src/index.ts';
import { signUploadParams } from '../src/lib/cloudinary.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { appRouter } from '../src/trpc/router.ts';

const USER_ID = 'user-test-1';
const USER_EMAIL = 'tester@example.com';
const SESSION_ID = 'session-test-1';

const cloudinary = {
  cloudName: 'test-cloud',
  apiKey: 'test-key',
  apiSecret: 'super-secret',
};

function makeContext(overrides: { authenticated?: boolean } = {}): AppContext {
  const authenticated = overrides.authenticated ?? true;
  return {
    req: {} as AppContext['req'],
    reply: {} as AppContext['reply'],
    reqId: 'rid-test',
    // The uploads procedure does no DB I/O, so a placeholder is safe; cast is
    // narrowed to AppContext['db'] to avoid leaking the placeholder shape.
    db: {} as AppContext['db'],
    cloudinary,
    session: authenticated
      ? {
          id: SESSION_ID,
          userId: USER_ID,
          token: 'tok',
          expiresAt: new Date(Date.now() + 60_000),
          ipAddress: null,
          userAgent: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      : null,
    user: authenticated
      ? {
          id: USER_ID,
          email: USER_EMAIL,
          name: 'Test User',
          emailVerified: true,
          image: null,
          themePreference: 'system',
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      : null,
  };
}

describe('uploads procedures', () => {
  describe('getRecipeImageCredentials', () => {
    it('returns a credential bundle with the locked Cloudinary constraints', async () => {
      const caller = appRouter.createCaller(makeContext());
      const creds = await caller.uploads.getRecipeImageCredentials();

      expect(creds.cloudName).toBe('test-cloud');
      expect(creds.apiKey).toBe('test-key');
      expect(creds.folder).toBe(RECIPE_IMAGE_FOLDER);
      expect(creds.allowedFormats).toEqual([...RECIPE_IMAGE_ALLOWED_FORMATS]);
      expect(creds.maxFileSize).toBe(RECIPE_IMAGE_MAX_FILE_SIZE);
      expect(creds.transformation).toBe(RECIPE_IMAGE_EAGER_TRANSFORMATION);
    });

    it('returns a fresh Unix-seconds timestamp', async () => {
      const before = Math.floor(Date.now() / 1000);
      const caller = appRouter.createCaller(makeContext());
      const creds = await caller.uploads.getRecipeImageCredentials();
      const after = Math.floor(Date.now() / 1000);

      expect(creds.timestamp).toBeGreaterThanOrEqual(before);
      expect(creds.timestamp).toBeLessThanOrEqual(after);
    });

    it('signs the bundle with the configured secret over the locked params', async () => {
      const caller = appRouter.createCaller(makeContext());
      const creds = await caller.uploads.getRecipeImageCredentials();

      // `max_file_size` is deliberately omitted from the signed set — it is
      // a Pro-plan-only Cloudinary upload param and lower plans strip it
      // before signature verification, which would produce a 401. The cap
      // is enforced client-side in the uploader instead.
      const expected = signUploadParams(
        {
          allowed_formats: RECIPE_IMAGE_ALLOWED_FORMATS.join(','),
          eager: RECIPE_IMAGE_EAGER_TRANSFORMATION,
          folder: RECIPE_IMAGE_FOLDER,
          timestamp: creds.timestamp,
        },
        cloudinary.apiSecret,
      );

      expect(creds.signature).toBe(expected);
      expect(creds.signature).toMatch(/^[a-f0-9]{40}$/);
    });

    it('rejects unauthenticated callers', async () => {
      const caller = appRouter.createCaller(
        makeContext({ authenticated: false }),
      );
      await expect(
        caller.uploads.getRecipeImageCredentials(),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });
});
