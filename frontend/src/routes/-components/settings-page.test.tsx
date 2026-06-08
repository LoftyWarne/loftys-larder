import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMeMock, updateProfileMock, useUtilsMock } = vi.hoisted(() => ({
  getMeMock: vi.fn(),
  updateProfileMock: vi.fn(),
  useUtilsMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    user: {
      getMe: { useQuery: getMeMock },
      updateProfile: { useMutation: updateProfileMock },
    },
    useUtils: useUtilsMock,
  },
}));

import { SettingsPage } from './settings-page.tsx';

const ME = {
  id: 'u-1',
  email: 'me@example.com',
  name: 'Test User',
  themePreference: 'system' as const,
};

interface SetupOptions {
  mutateAsync?: ReturnType<typeof vi.fn>;
}

function setup(options: SetupOptions = {}): {
  mutateAsync: ReturnType<typeof vi.fn>;
} {
  getMeMock.mockReturnValue({
    data: ME,
    isLoading: false,
    error: null,
  });
  const invalidate = vi.fn().mockResolvedValue(undefined);
  useUtilsMock.mockReturnValue({
    user: { getMe: { invalidate } },
  });
  const mutateAsync = options.mutateAsync ?? vi.fn().mockResolvedValue(ME);
  updateProfileMock.mockReturnValue({ mutateAsync });
  return { mutateAsync };
}

beforeEach(() => {
  getMeMock.mockReset();
  updateProfileMock.mockReset();
  useUtilsMock.mockReset();
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
});
