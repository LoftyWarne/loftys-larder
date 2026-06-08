import { router } from './init.ts';
import { healthRouter } from './procedures/health.ts';
import { ingredientsRouter } from './procedures/ingredients.ts';
import { uploadsRouter } from './procedures/uploads.ts';
import { userRouter } from './procedures/user.ts';

export const appRouter = router({
  health: healthRouter,
  user: userRouter,
  ingredients: ingredientsRouter,
  uploads: uploadsRouter,
});

export type AppRouter = typeof appRouter;
