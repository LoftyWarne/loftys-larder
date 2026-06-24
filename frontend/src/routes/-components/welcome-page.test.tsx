import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getSessionMock,
  updateProfileMock,
  useUtilsMock,
  refreshSessionMock,
  navigateMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  updateProfileMock: vi.fn(),
  useUtilsMock: vi.fn(),
  refreshSessionMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    user: {
      updateProfile: { useMutation: updateProfileMock },
    },
    useUtils: useUtilsMock,
  },
}));

vi.mock('@/lib/auth-client.ts', () => ({
  authClient: {
    getSession: getSessionMock,
  },
  refreshSession: refreshSessionMock,
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import { WelcomePage, welcomeBeforeLoad } from './welcome-page.tsx';

interface SetupOptions {
  mutateAsync?: ReturnType<typeof vi.fn>;
}

function setup(options: SetupOptions = {}): {
  mutateAsync: ReturnType<typeof vi.fn>;
} {
  const invalidate = vi.fn().mockResolvedValue(undefined);
  useUtilsMock.mockReturnValue({ user: { getMe: { invalidate } } });
  const mutateAsync =
    options.mutateAsync ?? vi.fn().mockResolvedValue(undefined);
  // Mirror useMutation: run onSuccess after a successful mutateAsync so the
  // cache-invalidate + session-refresh path is exercised.
  updateProfileMock.mockImplementation(
    (opts?: { onSuccess?: () => unknown }) => {
      const wrapped = vi.fn().mockImplementation(async (input: unknown) => {
        const result: unknown = await mutateAsync(input);
        await opts?.onSuccess?.();
        return result;
      });
      return { mutateAsync: wrapped };
    },
  );
  return { mutateAsync };
}

beforeEach(() => {
  getSessionMock.mockReset();
  updateProfileMock.mockReset();
  useUtilsMock.mockReset();
  refreshSessionMock.mockReset();
  navigateMock.mockReset();
});

describe('welcomeBeforeLoad', () => {
  it('redirects to /sign-in when there is no session', async () => {
    getSessionMock.mockResolvedValue({ data: null });
    await expect(welcomeBeforeLoad()).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
  });

  it('redirects to / when the user already has a name', async () => {
    getSessionMock.mockResolvedValue({
      data: { user: { id: 'u1', name: 'Ada' } },
    });
    await expect(welcomeBeforeLoad()).rejects.toMatchObject({
      options: { to: '/' },
    });
  });

  it('stays on the page when the name is blank', async () => {
    getSessionMock.mockResolvedValue({
      data: { user: { id: 'u1', name: '' } },
    });
    await expect(welcomeBeforeLoad()).resolves.toBeUndefined();
  });
});

describe('WelcomePage', () => {
  it('requires a name before submitting', async () => {
    const { mutateAsync } = setup();
    const user = userEvent.setup();
    render(<WelcomePage />);

    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('saves the trimmed name and navigates home on success', async () => {
    const { mutateAsync } = setup();
    const user = userEvent.setup();
    render(<WelcomePage />);

    await user.type(screen.getByLabelText(/name/i), '  Ada Lovelace  ');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ name: 'Ada Lovelace' });
    });
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({ to: '/' });
    });
  });

  it('surfaces an inline error and does not navigate when the save fails', async () => {
    const mutateAsync = vi.fn().mockRejectedValue(new Error('Server is down'));
    setup({ mutateAsync });
    const user = userEvent.setup();
    render(<WelcomePage />);

    await user.type(screen.getByLabelText(/name/i), 'Ada');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText(/server is down/i)).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
