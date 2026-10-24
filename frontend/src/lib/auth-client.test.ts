import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendVerificationOtpMock } = vi.hoisted(() => ({
  sendVerificationOtpMock: vi.fn(),
}));

vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    emailOtp: { sendVerificationOtp: sendVerificationOtpMock },
  }),
}));

import { sendSignInCode, signInErrorMessage } from './auth-client.ts';

beforeEach(() => {
  sendVerificationOtpMock.mockReset();
});

describe('sendSignInCode', () => {
  it('asks Better Auth for a sign-in code for the email', async () => {
    sendVerificationOtpMock.mockResolvedValue({ data: {}, error: null });
    await expect(sendSignInCode('cook@example.com')).resolves.toBeNull();
    expect(sendVerificationOtpMock).toHaveBeenCalledWith({
      email: 'cook@example.com',
      type: 'sign-in',
    });
  });

  it('resolves to a readable message when the send fails', async () => {
    sendVerificationOtpMock.mockResolvedValue({
      data: null,
      error: { code: 'RATE_LIMITED' },
    });
    await expect(sendSignInCode('cook@example.com')).resolves.toMatch(
      /too many attempts/i,
    );
  });
});

describe('signInErrorMessage', () => {
  it.each([
    ['INVALID_OTP', /isn’t right/i],
    ['OTP_EXPIRED', /has expired/i],
    ['TOO_MANY_ATTEMPTS', /too many wrong tries/i],
    ['RATE_LIMITED', /too many attempts\. try again later/i],
  ])('explains %s', (code, message) => {
    expect(signInErrorMessage({ code }, 'fallback')).toMatch(message);
  });

  it('says when a rate-limited request can be tried again', () => {
    expect(
      signInErrorMessage(
        { code: 'RATE_LIMITED', retryAfterSeconds: 1500 },
        'fallback',
      ),
    ).toBe('Too many attempts. Try again in 25 minutes.');
    expect(
      signInErrorMessage({ code: 'RATE_LIMITED', retryAfterSeconds: 5 }, 'f'),
    ).toBe('Too many attempts. Try again in 1 minute.');
  });

  it('uses the server message for any other error', () => {
    expect(signInErrorMessage({ message: 'Resend is down' }, 'fallback')).toBe(
      'Resend is down',
    );
  });

  it('falls back when the error has no message', () => {
    expect(signInErrorMessage({}, 'fallback')).toBe('fallback');
  });
});
