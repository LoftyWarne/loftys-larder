import { router } from './init.ts';
import { healthRouter } from './procedures/health.ts';
import { ingredientsRouter } from './procedures/ingredients.ts';
import { plansRouter } from './procedures/plans.ts';
import { plantsRouter } from './procedures/plants.ts';
import { recipeDraftsRouter } from './procedures/recipe-drafts.ts';
import { recipesRouter } from './procedures/recipes.ts';
import { shoppingRouter } from './procedures/shopping.ts';
import { slotsRouter } from './procedures/slots.ts';
import { uploadsRouter } from './procedures/uploads.ts';
import { userRouter } from './procedures/user.ts';

export const appRouter = router({
  health: healthRouter,
  user: userRouter,
  ingredients: ingredientsRouter,
  recipes: recipesRouter,
  recipeDrafts: recipeDraftsRouter,
  uploads: uploadsRouter,
  plans: plansRouter,
  plants: plantsRouter,
  slots: slotsRouter,
  shopping: shoppingRouter,
});

export type AppRouter = typeof appRouter;
