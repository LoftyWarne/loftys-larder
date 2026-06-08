import { router } from './init.ts';
import { healthRouter } from './procedures/health.ts';
import { userRouter } from './procedures/user.ts';

export const appRouter = router({
  health: healthRouter,
  user: userRouter,
});

export type AppRouter = typeof appRouter;
