import { describe, expect, it } from 'vitest';

import { emailDomainForLog, signInEmail } from '../src/auth/sign-in-email.ts';

describe('signInEmail', () => {
  it('trims and lowercases the email field', () => {
    expect(signInEmail({ email: '  Cook@Example.COM ' })).toBe(
      'cook@example.com',
    );
  });

  it.each([null, 'text', { email: 42 }, {}])(
    'is empty for a body without a string email (%j)',
    (body) => {
      expect(signInEmail(body)).toBe('');
    },
  );
});

describe('emailDomainForLog', () => {
  it('keeps only the domain of a real address', () => {
    expect(emailDomainForLog('stranger@example.com')).toBe('example.com');
  });

  it.each(['', 'not an email', `${'a'.repeat(300)}@example.com`])(
    'logs nothing for %s',
    (value) => {
      expect(emailDomainForLog(value)).toBeNull();
    },
  );
});
