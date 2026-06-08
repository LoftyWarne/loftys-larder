import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  CURRENT_HOUSEHOLD_ID,
  loadConfig,
} from '../src/config.ts';

const baseEnv = {
  NODE_ENV: 'test',
  ALLOWED_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://lofty:lofty@localhost:5433/lofty_dev',
  BETTER_AUTH_SECRET: 'test-secret-thirty-two-characters-long!',
  BETTER_AUTH_URL: 'http://localhost:3000',
  RESEND_API_KEY: 're_test_key',
  MAGIC_LINK_TRUSTED_ORIGIN: 'http://localhost:5173',
  MAGIC_LINK_ALLOWED_EMAILS: 'allowed@example.com',
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET: 'test-secret',
} as const;

function envWithout(
  key: keyof typeof baseEnv,
): Partial<Record<keyof typeof baseEnv, string>> {
  return Object.fromEntries(Object.entries(baseEnv).filter(([k]) => k !== key));
}

describe('loadConfig', () => {
  it('applies defaults for unspecified vars', () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT from string to number', () => {
    const config = loadConfig({ ...baseEnv, PORT: '4123' });
    expect(config.PORT).toBe(4123);
  });

  it('rejects missing ALLOWED_ORIGIN outside production', () => {
    expect(() =>
      loadConfig({ ...envWithout('ALLOWED_ORIGIN'), NODE_ENV: 'development' }),
    ).toThrowError(ConfigValidationError);
  });

  it('allows missing ALLOWED_ORIGIN in production', () => {
    const config = loadConfig({
      ...envWithout('ALLOWED_ORIGIN'),
      NODE_ENV: 'production',
    });
    expect(config.ALLOWED_ORIGIN).toBeUndefined();
    expect(config.NODE_ENV).toBe('production');
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'staging' })).toThrowError(
      ConfigValidationError,
    );
  });

  it('rejects an invalid ALLOWED_ORIGIN url', () => {
    expect(() =>
      loadConfig({ ...baseEnv, ALLOWED_ORIGIN: 'not-a-url' }),
    ).toThrowError(ConfigValidationError);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: 'abc' })).toThrowError(
      ConfigValidationError,
    );
  });

  it('rejects missing DATABASE_URL in every environment', () => {
    expect(() => loadConfig(envWithout('DATABASE_URL'))).toThrowError(
      ConfigValidationError,
    );
    expect(() =>
      loadConfig({ ...envWithout('DATABASE_URL'), NODE_ENV: 'production' }),
    ).toThrowError(ConfigValidationError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      loadConfig({ ...baseEnv, DATABASE_URL: 'https://example.com' }),
    ).toThrowError(ConfigValidationError);
  });

  it('rejects a malformed DATABASE_URL', () => {
    expect(() =>
      loadConfig({ ...baseEnv, DATABASE_URL: 'not-a-url' }),
    ).toThrowError(ConfigValidationError);
  });

  it('rejects a short BETTER_AUTH_SECRET', () => {
    expect(() =>
      loadConfig({ ...baseEnv, BETTER_AUTH_SECRET: 'too-short' }),
    ).toThrowError(ConfigValidationError);
  });

  it('rejects missing RESEND_API_KEY', () => {
    expect(() => loadConfig(envWithout('RESEND_API_KEY'))).toThrowError(
      ConfigValidationError,
    );
  });

  it('defaults MAGIC_LINK_FROM to the verified sender', () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.MAGIC_LINK_FROM).toBe('magic@loftys-larder.co.uk');
  });

  it('parses MAGIC_LINK_ALLOWED_EMAILS into a lowercase array', () => {
    const config = loadConfig({
      ...baseEnv,
      MAGIC_LINK_ALLOWED_EMAILS: ' Alice@Example.com , bob@example.com ',
    });
    expect(config.MAGIC_LINK_ALLOWED_EMAILS).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
  });

  it('rejects an empty MAGIC_LINK_ALLOWED_EMAILS list', () => {
    expect(() =>
      loadConfig({ ...baseEnv, MAGIC_LINK_ALLOWED_EMAILS: '   ,   ' }),
    ).toThrowError(ConfigValidationError);
  });

  it('rejects a malformed entry in MAGIC_LINK_ALLOWED_EMAILS', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        MAGIC_LINK_ALLOWED_EMAILS: 'alice@example.com,not-an-email',
      }),
    ).toThrowError(ConfigValidationError);
  });

  it('accepts both postgres:// and postgresql:// DATABASE_URL prefixes', () => {
    const a = loadConfig({
      ...baseEnv,
      DATABASE_URL: 'postgres://u:p@h:5432/db',
    });
    const b = loadConfig({
      ...baseEnv,
      DATABASE_URL: 'postgresql://u:p@h:5432/db',
    });
    expect(a.DATABASE_URL).toBe('postgres://u:p@h:5432/db');
    expect(b.DATABASE_URL).toBe('postgresql://u:p@h:5432/db');
  });
});

describe('CURRENT_HOUSEHOLD_ID', () => {
  it('is a fixed UUID exported from config', () => {
    expect(CURRENT_HOUSEHOLD_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
