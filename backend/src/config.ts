import { z } from 'zod';

// Single-household MVP scope constant (DEC-17). Every domain query must include
// `where household_id = CURRENT_HOUSEHOLD_ID`. FEAT-10's seed inserts a
// households row with this id.
export const CURRENT_HOUSEHOLD_ID = '00000000-0000-4000-8000-000000000001';

const databaseUrlSchema = z
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: 'DATABASE_URL must be a postgres:// or postgresql:// URL.',
  });

const allowedEmailsSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.email()).min(1));

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    ALLOWED_ORIGIN: z.url().optional(),
    STATIC_DIR: z.string().min(1).optional(),
    DATABASE_URL: databaseUrlSchema,
    // 32-byte minimum mirrors Better Auth's `generateRandomString(32)` default;
    // the secret signs session cookies and CSRF tokens (DEC-43).
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    RESEND_API_KEY: z.string().min(1),
    MAGIC_LINK_FROM: z.string().min(1).default('magic@loftys-larder.co.uk'),
    MAGIC_LINK_TRUSTED_ORIGIN: z.url(),
    // Allow-list gate (single-household MVP). Comma-separated emails; the
    // magic-link send fn silently drops requests for any address not on the
    // list so anyone guessing the sign-in URL cannot create an account.
    MAGIC_LINK_ALLOWED_EMAILS: allowedEmailsSchema,
    CLOUDINARY_CLOUD_NAME: z.string().min(1),
    CLOUDINARY_API_KEY: z.string().min(1),
    CLOUDINARY_API_SECRET: z.string().min(1),
    // Axiom ingest credentials (DEC-75). Required in production so logs reach
    // the aggregator; optional in dev/test where logs stay on stdout.
    AXIOM_TOKEN: z.string().min(1).optional(),
    AXIOM_DATASET: z.string().min(1).optional(),
    AXIOM_ENDPOINT: z.url().default('https://api.axiom.co'),
    // Sentry is best-effort observability (DEC-76). Missing DSN is a no-op
    // init — Sentry shouldn't block boot the way Axiom does. SAMPLE_RATE
    // defaults to 0 (traces off, DEC-77 explicitly punts distributed tracing).
    SENTRY_DSN: z.url().optional(),
    SENTRY_ENVIRONMENT: z.string().min(1).optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  })
  .refine(
    (value) => value.NODE_ENV === 'production' || Boolean(value.ALLOWED_ORIGIN),
    {
      path: ['ALLOWED_ORIGIN'],
      message:
        'ALLOWED_ORIGIN is required outside production (used by the dev-only CORS origin).',
    },
  )
  .refine(
    (value) => value.NODE_ENV !== 'production' || Boolean(value.AXIOM_TOKEN),
    {
      path: ['AXIOM_TOKEN'],
      message:
        'AXIOM_TOKEN is required in production (Pino → Axiom transport, DEC-75).',
    },
  )
  .refine(
    (value) => value.NODE_ENV !== 'production' || Boolean(value.AXIOM_DATASET),
    {
      path: ['AXIOM_DATASET'],
      message:
        'AXIOM_DATASET is required in production (Pino → Axiom transport, DEC-75).',
    },
  );

export type Config = z.infer<typeof configSchema>;

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `- ${path}: ${issue.message}`;
    });
    throw new ConfigValidationError(issues);
  }
  return result.data;
}
