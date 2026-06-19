import {
  inferAdditionalFields,
  magicLinkClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Better Auth's client requires a fully-qualified URL. Using the page's own
// origin works in both dev (Vite proxies /api/* to the backend) and prod
// (Fastify serves /api/* and the SPA on the same origin).
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [
    magicLinkClient(),
    // Mirrors the server-side `user.additionalFields` shape so `session.user`
    // carries `themePreference` with the right type. Kept inline rather than
    // imported from the server to preserve the workspace boundary.
    inferAdditionalFields({
      user: {
        themePreference: { type: 'string', required: true },
      },
    }),
  ],
});

export const { useSession, signIn, signOut, getSession } = authClient;

// The session atom is auto-refreshed only when Better Auth's own endpoints
// (e.g. /update-user) are called. We mutate the user via tRPC, so anything
// the session carries — currently `themePreference` — must trigger a manual
// refresh, otherwise `useSession` consumers (notably ThemeProvider) stay stale
// until a hard reload.
export function refreshSession(): void {
  authClient.$store.notify('$sessionSignal');
}
