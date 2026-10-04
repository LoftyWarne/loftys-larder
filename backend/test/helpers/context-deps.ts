import pino from 'pino';

import { PageUnreadableError } from '../../src/lib/recipe-import/fetch-page.ts';
import { createFakeRecipeReader } from '../../src/lib/recipe-reader/fake.ts';
import type { AppContext } from '../../src/trpc/context.ts';

// Context fields that procedure tests outside Recipe Import don't exercise.
export function contextDeps(): Pick<
  AppContext,
  'log' | 'recipeImport' | 'destroyImage'
> {
  return {
    log: pino({ level: 'silent' }),
    destroyImage: () => Promise.resolve(),
    recipeImport: {
      reader: createFakeRecipeReader(),
      fetchPage: () => Promise.reject(new PageUnreadableError('network')),
      allowStart: () =>
        Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    },
  };
}
