import {
  emailOTPClient,
  inferAdditionalFields,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Better Auth's client requires a fully-qualified URL. Using the page's own
// origin works in both dev (Vite proxies /api/* to the backend) and prod
// (Fastify serves /api/* and the SPA on the same origin).
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [
    emailOTPClient(),
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

interface AuthClientError {
  code?: string | undefined;
  message?: string | undefined;
  retryAfterSeconds?: number | undefined;
}

// Our Fastify rate limiters answer before Better Auth does, with their own
// `RATE_LIMITED` code, a `retryAfterSeconds` and no message. They cover both
// sending codes and entering them.
function rateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) {
    return 'Too many attempts. Try again later.';
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Try again in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`;
}

export function signInErrorMessage(
  error: AuthClientError,
  fallback: string,
): string {
  switch (error.code) {
    case 'INVALID_OTP':
      return 'That code isn’t right. Check the email and try again.';
    case 'OTP_EXPIRED':
      return 'That code has expired. Send a new one.';
    case 'TOO_MANY_ATTEMPTS':
      return 'Too many wrong tries. Send a new code.';
    case 'RATE_LIMITED':
      return rateLimitedMessage(error.retryAfterSeconds);
    default:
      return error.message ?? fallback;
  }
}

// Resolves to an error message, or null once the code is on its way.
export async function sendSignInCode(email: string): Promise<string | null> {
  const { error } = await authClient.emailOtp.sendVerificationOtp({
    email,
    type: 'sign-in',
  });
  return error
    ? signInErrorMessage(error, 'Could not send a sign-in code. Try again.')
    : null;
}
