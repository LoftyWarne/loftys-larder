import { describe, expect, it } from 'vitest';

import { copyForError, verifyBeforeLoad } from './auth.verify.tsx';

describe('copyForError', () => {
  it('returns expired-link copy for EXPIRED_TOKEN', () => {
    expect(copyForError('EXPIRED_TOKEN')).toMatchObject({
      heading: /expired/i,
    });
  });

  it('returns invalid/used-link copy for INVALID_TOKEN', () => {
    expect(copyForError('INVALID_TOKEN')).toMatchObject({
      heading: /no longer valid/i,
    });
  });

  it('returns generic-failure copy for any other code', () => {
    expect(copyForError('failed_to_create_session')).toMatchObject({
      heading: /could not sign you in/i,
    });
    expect(copyForError('')).toMatchObject({
      heading: /could not sign you in/i,
    });
  });
});

describe('verifyBeforeLoad', () => {
  it('redirects to / when no error param is present', () => {
    let caught: unknown;
    try {
      verifyBeforeLoad({ search: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ options: { to: '/' } });
  });

  it('does not throw when an error param is present', () => {
    expect(() => {
      verifyBeforeLoad({ search: { error: 'EXPIRED_TOKEN' } });
    }).not.toThrow();
  });
});
