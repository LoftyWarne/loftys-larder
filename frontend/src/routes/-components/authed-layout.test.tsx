import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-client.ts', () => ({
  authClient: {
    getSession: vi.fn(),
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    createFileRoute: () => (config: unknown) => config,
  };
});

import { authClient } from '@/lib/auth-client.ts';
import { authedBeforeLoad } from './authed-layout.tsx';

const getSessionMock = authClient.getSession as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  getSessionMock.mockReset();
});

describe('authedBeforeLoad', () => {
  it('throws a redirect to /sign-in when there is no session', async () => {
    getSessionMock.mockResolvedValue({ data: null });
    await expect(authedBeforeLoad()).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
  });

  it('does nothing when a session is present', async () => {
    getSessionMock.mockResolvedValue({ data: { user: { id: 'u1' } } });
    await expect(authedBeforeLoad()).resolves.toBeUndefined();
  });
});
