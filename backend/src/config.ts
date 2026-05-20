import { z } from 'zod';

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
    ALLOWED_ORIGIN: z.string().url().optional(),
    STATIC_DIR: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production' && !value.ALLOWED_ORIGIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOWED_ORIGIN'],
        message:
          'ALLOWED_ORIGIN is required outside production (used by the dev-only CORS origin).',
      });
    }
  });

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
