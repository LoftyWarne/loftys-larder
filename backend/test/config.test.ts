import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from '../src/config.ts';

const baseEnv = {
  NODE_ENV: 'test',
  ALLOWED_ORIGIN: 'http://localhost:5173',
} as const;

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
    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrowError(ConfigValidationError);
  });

  it('allows missing ALLOWED_ORIGIN in production', () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    expect(config.ALLOWED_ORIGIN).toBeUndefined();
    expect(config.NODE_ENV).toBe('production');
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'staging' })).toThrowError(
      ConfigValidationError,
    );
  });

  it('rejects an invalid ALLOWED_ORIGIN url', () => {
    expect(() => loadConfig({ ...baseEnv, ALLOWED_ORIGIN: 'not-a-url' })).toThrowError(
      ConfigValidationError,
    );
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: 'abc' })).toThrowError(ConfigValidationError);
  });
});
