import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Better Auth's client requires a fully-qualified URL. Using the page's own
// origin works in both dev (Vite proxies /api/* to the backend) and prod
// (Fastify serves /api/* and the SPA on the same origin).
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [magicLinkClient()],
});

export const { useSession, signIn, signOut, getSession } = authClient;
