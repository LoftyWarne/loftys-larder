import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getMeMock,
  updateProfileMock,
  getDeletionSummaryMock,
  deleteAccountMock,
  useUtilsMock,
  signOutMock,
  refreshSessionMock,
  navigateMock,
} = vi.hoisted(() => ({
  getMeMock: vi.fn(),
  updateProfileMock: vi.fn(),
  getDeletionSummaryMock: vi.fn(),
  deleteAccountMock: vi.fn(),
  useUtilsMock: vi.fn(),
  signOutMock: vi.fn(),
  refreshSessionMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    user: {
      getMe: { useQuery: getMeMock },
      updateProfile: { useMutation: updateProfileMock },
      getDeletionSummary: { useQuery: getDeletionSummaryMock },
      deleteAccount: { useMutation: deleteAccountMock },
    },
    useUtils: useUtilsMock,
  },
}));

vi.mock('@/lib/auth-client.ts', () => ({
  authClient: {
    signOut: signOutMock,
  },
  refreshSession: refreshSessionMock,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

import { SettingsPage } from './settings-page.tsx';

const ME = {
  id: 'u-1',
  email: 'me@example.com',
  name: 'Test User',
  themePreference: 'system' as const,
};

const SUMMARY = { commentCount: 2, recipeCount: 3, planCount: 1 };

interface SetupOptions {
  mutateAsync?: ReturnType<typeof vi.fn>;
  deleteMutateAsync?: ReturnType<typeof vi.fn>;
  deletePending?: boolean;
  summary?: typeof SUMMARY | undefined;
  summaryLoading?: boolean;
}

function setup(options: SetupOptions = {}): {
  mutateAsync: ReturnType<typeof vi.fn>;
  deleteMutateAsync: ReturnType<typeof vi.fn>;
} {
  getMeMock.mockReturnValue({
    data: ME,
    isLoading: false,
    error: null,
  });
  getDeletionSummaryMock.mockReturnValue({
    data: options.summary ?? SUMMARY,
    isLoading: options.summaryLoading ?? false,
    error: null,
  });
  const invalidate = vi.fn().mockResolvedValue(undefined);
  useUtilsMock.mockReturnValue({
    user: { getMe: { invalidate } },
  });
  const rawMutateAsync = options.mutateAsync ?? vi.fn().mockResolvedValue(ME);
  // Mirror useMutation's real behaviour: run onSuccess after a successful
  // mutateAsync so the test exercises the cache-invalidate + session-refresh
  // path.
  updateProfileMock.mockImplementation(
    (opts?: { onSuccess?: () => unknown }) => {
      const mutateAsync = vi.fn().mockImplementation(async (input: unknown) => {
        const result: unknown = await rawMutateAsync(input);
        await opts?.onSuccess?.();
        return result;
      });
      return { mutateAsync };
    },
  );
  const deleteMutateAsync =
    options.deleteMutateAsync ?? vi.fn().mockResolvedValue({ deleted: true });
  deleteAccountMock.mockReturnValue({
    mutateAsync: deleteMutateAsync,
    isPending: options.deletePending ?? false,
  });
  signOutMock.mockResolvedValue(undefined);
  navigateMock.mockResolvedValue(undefined);
  return { mutateAsync: rawMutateAsync, deleteMutateAsync };
}

beforeEach(() => {
  getMeMock.mockReset();
  updateProfileMock.mockReset();
  getDeletionSummaryMock.mockReset();
  deleteAccountMock.mockReset();
  useUtilsMock.mockReset();
  signOutMock.mockReset();
  refreshSessionMock.mockReset();
  navigateMock.mockReset();
});

describe('SettingsPage', () => {
  it('shows a loading state before the profile loads', () => {
    getMeMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    useUtilsMock.mockReturnValue({ user: { getMe: { invalidate: vi.fn() } } });
    updateProfileMock.mockReturnValue({ mutateAsync: vi.fn() });

    render(<SettingsPage />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
  });

  it('renders the current name and pre-selects the current theme', async () => {
    setup();
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Test User');
    });
    const systemRadio = screen.getByRole('radio', { name: /system/i });
    expect(systemRadio).toBeChecked();
  });

  it('calls updateProfile with name-only when the name changes', async () => {
    const { mutateAsync } = setup();
    const user = userEvent.setup();
    render(<SettingsPage />);

    const nameInput = await screen.findByLabelText('Name');
    await waitFor(() => {
      expect(nameInput).toHaveValue('Test User');
    });
    await user.clear(nameInput);
    await user.type(nameInput, 'New Name');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mutateAsync).toHaveBeenCalledWith({ name: 'New Name' });
  });

  it('calls updateProfile with themePreference-only when the theme changes', async () => {
    const { mutateAsync } = setup();
    const user = userEvent.setup();
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Test User');
    });
    await user.click(screen.getByRole('radio', { name: /dark/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mutateAsync).toHaveBeenCalledWith({ themePreference: 'dark' });
  });

  it('shows a validation error for a whitespace-only name and does not mutate', async () => {
    const { mutateAsync } = setup();
    const user = userEvent.setup();
    render(<SettingsPage />);

    const nameInput = await screen.findByLabelText('Name');
    await waitFor(() => {
      expect(nameInput).toHaveValue('Test User');
    });
    await user.clear(nameInput);
    await user.type(nameInput, '   ');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('surfaces a server error inline and keeps the form editable', async () => {
    const mutateAsync = vi.fn().mockRejectedValue(new Error('Boom'));
    setup({ mutateAsync });
    const user = userEvent.setup();
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Test User');
    });
    await user.click(screen.getByRole('radio', { name: /dark/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    });
    expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled();
  });

  it('refreshes the Better Auth session after a successful save so ThemeProvider sees the new preference without a reload', async () => {
    setup();
    const user = userEvent.setup();
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Test User');
    });
    await user.click(screen.getByRole('radio', { name: /dark/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(refreshSessionMock).toHaveBeenCalledTimes(1);
    });
  });

  it('does not refresh the session when the save fails', async () => {
    setup({ mutateAsync: vi.fn().mockRejectedValue(new Error('Boom')) });
    const user = userEvent.setup();
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Test User');
    });
    await user.click(screen.getByRole('radio', { name: /dark/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    });
    expect(refreshSessionMock).not.toHaveBeenCalled();
  });

  it('shows a confirmation after a successful save', async () => {
    setup();
    const user = userEvent.setup();
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Test User');
    });
    await user.click(screen.getByRole('radio', { name: /light/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/saved/i);
    });
  });

  describe('Danger zone', () => {
    it('renders the heading, summary counts, and a Delete account button', async () => {
      setup();
      render(<SettingsPage />);
      await screen.findByLabelText('Name');

      expect(
        screen.getByRole('heading', { name: /danger zone/i }),
      ).toBeInTheDocument();
      expect(screen.getByText(/2 comments will become/i)).toBeInTheDocument();
      expect(screen.getByText(/3 recipes/i)).toBeInTheDocument();
      expect(screen.getByText(/1 meal plan/i)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /delete account/i }),
      ).toBeInTheDocument();
    });

    it('keeps the confirm button disabled until the typed email matches', async () => {
      setup();
      const user = userEvent.setup();
      render(<SettingsPage />);
      await screen.findByLabelText('Name');

      await user.click(screen.getByRole('button', { name: /delete account/i }));
      const confirmButton = await screen.findByRole('button', {
        name: /^delete account$/i,
      });
      expect(confirmButton).toBeDisabled();

      const input = screen.getByLabelText(/your email/i);
      await user.type(input, 'me@example.com');
      expect(confirmButton).toBeEnabled();
    });

    it('runs deleteAccount, signs out, and navigates to /sign-in?deleted=1', async () => {
      const { deleteMutateAsync } = setup();
      const user = userEvent.setup();
      render(<SettingsPage />);
      await screen.findByLabelText('Name');

      await user.click(screen.getByRole('button', { name: /delete account/i }));
      await user.type(screen.getByLabelText(/your email/i), 'me@example.com');
      const confirmButton = await screen.findByRole('button', {
        name: /^delete account$/i,
      });
      await user.click(confirmButton);

      await waitFor(() => {
        expect(deleteMutateAsync).toHaveBeenCalledWith({
          emailConfirmation: 'me@example.com',
        });
      });
      await waitFor(() => {
        expect(signOutMock).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(navigateMock).toHaveBeenCalledWith({
          to: '/sign-in',
          search: { deleted: '1' },
        });
      });
    });

    it('renders a server error in the dialog without closing it', async () => {
      const deleteMutateAsync = vi.fn().mockRejectedValue(new Error('Boom'));
      setup({ deleteMutateAsync });
      const user = userEvent.setup();
      render(<SettingsPage />);
      await screen.findByLabelText('Name');

      await user.click(screen.getByRole('button', { name: /delete account/i }));
      await user.type(screen.getByLabelText(/your email/i), 'me@example.com');
      await user.click(
        await screen.findByRole('button', { name: /^delete account$/i }),
      );

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Boom');
      });
      // Dialog is still open; the input is still rendered.
      expect(screen.getByLabelText(/your email/i)).toBeInTheDocument();
      expect(navigateMock).not.toHaveBeenCalled();
      expect(signOutMock).not.toHaveBeenCalled();
    });

    it('disables the confirm button while the mutation is pending', async () => {
      setup({ deletePending: true });
      const user = userEvent.setup();
      render(<SettingsPage />);
      await screen.findByLabelText('Name');

      await user.click(screen.getByRole('button', { name: /delete account/i }));
      await user.type(screen.getByLabelText(/your email/i), 'me@example.com');
      const confirmButton = await screen.findByRole('button', {
        name: /deleting…/i,
      });
      expect(confirmButton).toBeDisabled();
    });
  });
});
