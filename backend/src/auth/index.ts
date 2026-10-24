import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import * as schema from '../db/schema/index.ts';
import type { SignInCodeSender } from './resend.ts';

const TEN_MINUTES_IN_SECONDS = 60 * 10;
const ONE_DAY_IN_SECONDS = 60 * 60 * 24;
const THIRTY_DAYS_IN_SECONDS = ONE_DAY_IN_SECONDS * 30;

export interface CreateAuthOptions {
  config: Config;
  db: Db;
  sendSignInCode: SignInCodeSender;
}

// Multi-user households are a non-goal in v1 (DEC-17): every authenticated user
// is implicitly a member of the seeded household. No user->household join row
// is recorded here.
export type Auth = ReturnType<typeof createAuth>;

// Set by `plugins/auth.ts` from Fastify's proxy-aware `req.ip`.
export const CLIENT_IP_HEADER = 'x-lofty-client-ip';

export function createAuth({ config, db, sendSignInCode }: CreateAuthOptions) {
  const allowedEmails = new Set(config.MAGIC_LINK_ALLOWED_EMAILS);
  return betterAuth({
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.MAGIC_LINK_TRUSTED_ORIGIN],
    // Routes the email-OTP plugin mounts that aren't part of sign-in. The
    // Fastify route blocks them too (`plugins/auth.ts`); this check runs on
    // Better Auth's own normalised path.
    disabledPaths: [
      '/email-otp/check-verification-otp',
      '/email-otp/verify-email',
      '/email-otp/request-password-reset',
      '/email-otp/reset-password',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
      '/forget-password/email-otp',
    ],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
      // Schema tables are pluralised (users/sessions/accounts/verifications).
      usePlural: true,
      // Schema field keys are camelCase; the snake_case mapping happens at the
      // Drizzle runtime layer via `casing: 'snake_case'` (DEC-15).
      camelCase: true,
    }),
    advanced: {
      cookiePrefix: 'lofty-larder',
      useSecureCookies: config.NODE_ENV === 'production',
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    // Backstop for the allow-list gate in `plugins/auth.ts`: no route may
    // create a user outside the single household (DEC-17, DEC-114).
    databaseHooks: {
      user: {
        create: {
          before: (user) => {
            if (allowedEmails.has(user.email.toLowerCase())) {
              return Promise.resolve();
            }
            throw new APIError('BAD_REQUEST', {
              code: 'INVALID_OTP',
              message: 'Invalid OTP',
            });
          },
        },
      },
    },
    // 30-day rolling window (DEC-93). Account deletion compensates by demanding
    // a recent sign-in — see `user.deleteAccount`.
    session: {
      expiresIn: THIRTY_DAYS_IN_SECONDS,
      updateAge: ONE_DAY_IN_SECONDS,
    },
    user: {
      additionalFields: {
        // Surfaces `themePreference` on `ctx.user` and on the client session
        // so the ThemeProvider can read it without an extra round-trip
        // (DEC-54). `input: false` keeps the field out of Better Auth's
        // sign-up/update payloads — domain writes go through `user.updateProfile`.
        themePreference: {
          type: 'string',
          required: true,
          defaultValue: 'system',
          input: false,
        },
      },
    },
    plugins: [
      // A code typed into the app rather than a link (DEC-114): a link opens
      // the default browser, which on iOS doesn't share the installed PWA's
      // cookies, so the session would land in the wrong place.
      emailOTP({
        otpLength: 8,
        expiresIn: TEN_MINUTES_IN_SECONDS,
        allowedAttempts: 3,
        storeOTP: 'hashed',
        disableSignUp: false,
        // Lets e2e type a known code; config refuses it in production.
        generateOTP: () => config.SIGN_IN_CODE_FIXED,
        sendVerificationOTP: async ({ email, otp, type }) => {
          // Only sign-in is wired up; the plugin's other routes are blocked
          // in `plugins/auth.ts`.
          if (type !== 'sign-in') return;
          await sendSignInCode({ to: email, code: otp });
        },
      }),
    ],
  });
}
