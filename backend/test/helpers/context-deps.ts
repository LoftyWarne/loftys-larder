import pino from 'pino';

import { PageUnreadableError } from '../../src/lib/recipe-import/fetch-page.ts';
import { createFakeRecipeReader } from '../../src/lib/recipe-reader/fake.ts';
import { createFakeRecipeScorer } from '../../src/lib/recipe-scorer/fake.ts';
import type { AppContext } from '../../src/trpc/context.ts';

// Context fields that procedure tests outside the model features don't
// exercise.
export function contextDeps(): Pick<
  AppContext,
  'log' | 'recipeImport' | 'healthScore' | 'destroyImage'
> {
  return {
    log: pino({ level: 'silent' }),
    destroyImage: () => Promise.resolve(),
    recipeImport: {
      reader: createFakeRecipeReader(),
      fetchPage: () => Promise.reject(new PageUnreadableError('network')),
      lookUpPdf: () => Promise.resolve(null),
      allowStart: () =>
        Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    },
    healthScore: {
      scorer: createFakeRecipeScorer(),
      since: '2026-10-07',
      allowScore: () =>
        Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    },
  };
}
