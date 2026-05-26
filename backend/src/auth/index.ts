import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import * as schema from '../db/schema/index.ts';
import type { MagicLinkSender } from './resend.ts';

const TEN_MINUTES_IN_SECONDS = 60 * 10;

export interface CreateAuthOptions {
  config: Config;
  db: Db;
  sendMagicLink: MagicLinkSender;
}

// Multi-user households are a non-goal in v1 (DEC-17): every authenticated user
// is implicitly a member of the seeded household. No user->household join row
// is recorded here.
export type Auth = ReturnType<typeof createAuth>;

export function createAuth({ config, db, sendMagicLink }: CreateAuthOptions) {
  return betterAuth({
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.MAGIC_LINK_TRUSTED_ORIGIN],
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
    },
    plugins: [
      magicLink({
        expiresIn: TEN_MINUTES_IN_SECONDS,
        disableSignUp: false,
        sendMagicLink: async ({ email, url }) => {
          await sendMagicLink({ to: email, url });
        },
      }),
    ],
  });
}
