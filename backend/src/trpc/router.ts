import { router } from './init.ts';
import { healthRouter } from './procedures/health.ts';

export const appRouter = router({
  health: healthRouter,
});

export type AppRouter = typeof appRouter;
