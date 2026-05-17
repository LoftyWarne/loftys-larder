import { router } from './init.ts';
import { healthRouter } from './procedures/health.ts';
export const appRouter = router({
    health: healthRouter,
});
//# sourceMappingURL=router.js.map