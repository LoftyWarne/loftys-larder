import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-client.ts', () => ({
  authClient: {
    signIn: { magicLink: vi.fn() },
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
import { SignInPage, signInBeforeLoad } from './sign-in.tsx';

const magicLinkMock = authClient.signIn.magicLink as unknown as ReturnType<
  typeof vi.fn
>;
const getSessionMock = authClient.getSession as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  magicLinkMock.mockReset();
  getSessionMock.mockReset();
});

describe('SignInPage form validation', () => {
  it('shows a validation error and does not call signIn for an empty email', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(
      screen.getByRole('button', { name: /send sign-in link/i }),
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(magicLinkMock).not.toHaveBeenCalled();
  });

  it('shows a validation error for a malformed email', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.type(screen.getByLabelText(/email/i), 'not-an-email');
    await user.click(
      screen.getByRole('button', { name: /send sign-in link/i }),
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(magicLinkMock).not.toHaveBeenCalled();
  });
});

describe('SignInPage submission', () => {
  it('calls signIn.magicLink with the email and shows the confirmation panel', async () => {
    magicLinkMock.mockResolvedValue({ data: { status: true }, error: null });
    const user = userEvent.setup();
    render(<SignInPage />);

    await user.type(screen.getByLabelText(/email/i), 'cook@example.com');
    await user.click(
      screen.getByRole('button', { name: /send sign-in link/i }),
    );

    await waitFor(() => {
      expect(magicLinkMock).toHaveBeenCalledTimes(1);
    });
    expect(magicLinkMock).toHaveBeenCalledWith({
      email: 'cook@example.com',
      callbackURL: '/',
      errorCallbackURL: '/auth/verify',
    });
    expect(
      await screen.findByRole('heading', { name: /check your email/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/cook@example\.com/)).toBeInTheDocument();
  });

  it('disables the submit button while the request is in flight', async () => {
    type Resolver = (value: { data: unknown; error: null }) => void;
    let resolve: Resolver = () => undefined;
    magicLinkMock.mockImplementation(
      () => new Promise((r) => (resolve = r as Resolver)),
    );
    const user = userEvent.setup();
    render(<SignInPage />);

    await user.type(screen.getByLabelText(/email/i), 'cook@example.com');
    await user.click(
      screen.getByRole('button', { name: /send sign-in link/i }),
    );

    const button = await screen.findByRole('button', { name: /sending…/i });
    expect(button).toBeDisabled();
    resolve({ data: { status: true }, error: null });
    await screen.findByRole('heading', { name: /check your email/i });
  });

  it('surfaces an inline error and re-enables the form on send failure', async () => {
    magicLinkMock.mockResolvedValue({
      data: null,
      error: { message: 'Resend is unavailable' },
    });
    const user = userEvent.setup();
    render(<SignInPage />);

    await user.type(screen.getByLabelText(/email/i), 'cook@example.com');
    await user.click(
      screen.getByRole('button', { name: /send sign-in link/i }),
    );

    expect(
      await screen.findByText(/resend is unavailable/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /send sign-in link/i }),
    ).toBeEnabled();
  });
});

describe('signInBeforeLoad', () => {
  it('does nothing when there is no session', async () => {
    getSessionMock.mockResolvedValue({ data: null });
    await expect(signInBeforeLoad()).resolves.toBeUndefined();
  });

  it('throws a redirect to / when the user already has a session', async () => {
    getSessionMock.mockResolvedValue({ data: { user: { id: 'u1' } } });
    await expect(signInBeforeLoad()).rejects.toMatchObject({
      options: { to: '/' },
    });
  });
});
