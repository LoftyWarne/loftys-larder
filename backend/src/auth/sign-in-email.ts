import { z } from 'zod';

export const SEND_CODE_PATH = '/api/auth/email-otp/send-verification-otp';
export const ENTER_CODE_PATH = '/api/auth/sign-in/email-otp';

// The address a sign-in code request names, normalised the way the allow-list
// is (trimmed, lowercased). Empty when the body has none.
export function signInEmail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const value = (body as Record<string, unknown>).email;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

const loggableEmail = z.email().max(254);

// The request body is the stranger's own text, so log only the domain of
// something that is really an email address, never the raw field.
export function emailDomainForLog(email: string): string | null {
  if (!loggableEmail.safeParse(email).success) return null;
  return email.slice(email.lastIndexOf('@') + 1);
}

// Keys in `rate_limit_hits` (`plugins/sign-in-limits.ts`). Account deletion
// clears them by the same shapes.
export const signInLimitKeys = {
  send: (email: string): string => `sign-in-send:${email}`,
  enter: (email: string): string => `sign-in-enter:${email}`,
  enterFromClient: (email: string, network: string): string =>
    `sign-in-enter:${email}:${network}`,
};
