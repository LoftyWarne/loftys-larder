import { createRouter } from '@tanstack/react-router';
import { AppPendingScreen } from './components/app-pending-screen.tsx';
import { routeTree } from './routeTree.gen.ts';

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: AppPendingScreen,
  defaultPendingMs: 300,
  defaultPendingMinMs: 400,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
