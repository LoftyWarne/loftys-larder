import pino from 'pino';

import { createFakeRecipeReader } from '../../src/lib/recipe-reader/fake.ts';
import type { AppContext } from '../../src/trpc/context.ts';

// Context fields that procedure tests outside Recipe Import don't exercise.
export function contextDeps(): Pick<AppContext, 'log' | 'recipeImport'> {
  return {
    log: pino({ level: 'silent' }),
    recipeImport: {
      reader: createFakeRecipeReader(),
      allowStart: () =>
        Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    },
  };
}
