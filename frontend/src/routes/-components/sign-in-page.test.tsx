import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendCodeMock, signInOtpMock, getSessionMock, navigateMock } =
  vi.hoisted(() => ({
    sendCodeMock: vi.fn(),
    signInOtpMock: vi.fn(),
    getSessionMock: vi.fn(),
    navigateMock: vi.fn(),
  }));

vi.mock('@/lib/auth-client.ts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-client.ts')>(
    '@/lib/auth-client.ts',
  );
  return {
    authClient: {
      signIn: { emailOtp: signInOtpMock },
      getSession: getSessionMock,
    },
    sendSignInCode: sendCodeMock,
    signInErrorMessage: actual.signInErrorMessage,
  };
});

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    createFileRoute: () => (config: unknown) => config,
    useNavigate: () => navigateMock,
  };
});

import { SignInPage, signInBeforeLoad } from './sign-in-page.tsx';

beforeEach(() => {
  sendCodeMock.mockReset();
  signInOtpMock.mockReset();
  getSessionMock.mockReset();
  navigateMock.mockReset();
});

async function requestCode(
  user: ReturnType<typeof userEvent.setup>,
  email = 'cook@example.com',
): Promise<void> {
  sendCodeMock.mockResolvedValue(null);
  await user.type(screen.getByLabelText(/email/i), email);
  await user.click(screen.getByRole('button', { name: /send sign-in code/i }));
  await screen.findByLabelText(/sign-in code/i);
}

describe('SignInPage form validation', () => {
  it('shows a validation error and does not call signIn for an empty email', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(
      screen.getByRole('button', { name: /send sign-in code/i }),
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(sendCodeMock).not.toHaveBeenCalled();
  });

  it('shows a validation error for a malformed email', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.type(screen.getByLabelText(/email/i), 'not-an-email');
    await user.click(
      screen.getByRole('button', { name: /send sign-in code/i }),
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(sendCodeMock).not.toHaveBeenCalled();
  });
});

describe('SignInPage submission', () => {
  it('sends a sign-in code to the email and asks for it', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);

    await requestCode(user);

    expect(sendCodeMock).toHaveBeenCalledWith('cook@example.com');
    expect(
      screen.getByRole('heading', { name: /check your email/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/cook@example\.com/)).toBeInTheDocument();
  });

  it('disables the submit button while the request is in flight', async () => {
    type Resolver = (value: string | null) => void;
    let resolve: Resolver = () => undefined;
    sendCodeMock.mockImplementation(
      () => new Promise((r) => (resolve = r as Resolver)),
    );
    const user = userEvent.setup();
    render(<SignInPage />);

    await user.type(screen.getByLabelText(/email/i), 'cook@example.com');
    await user.click(
      screen.getByRole('button', { name: /send sign-in code/i }),
    );

    const button = await screen.findByRole('button', { name: /sending…/i });
    expect(button).toBeDisabled();
    resolve(null);
    await screen.findByRole('heading', { name: /check your email/i });
  });

  it('surfaces an inline error and re-enables the form on send failure', async () => {
    sendCodeMock.mockResolvedValue('Resend is unavailable');
    const user = userEvent.setup();
    render(<SignInPage />);

    await user.type(screen.getByLabelText(/email/i), 'cook@example.com');
    await user.click(
      screen.getByRole('button', { name: /send sign-in code/i }),
    );

    expect(
      await screen.findByText(/resend is unavailable/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /send sign-in code/i }),
    ).toBeEnabled();
  });
});

describe('SignInPage code entry', () => {
  it('signs in as soon as the eighth digit is entered', async () => {
    signInOtpMock.mockResolvedValue({ data: {}, error: null });
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);

    await user.type(screen.getByLabelText(/sign-in code/i), '12345678');

    await waitFor(() => {
      expect(signInOtpMock).toHaveBeenCalledWith({
        email: 'cook@example.com',
        otp: '12345678',
      });
    });
    expect(navigateMock).toHaveBeenCalledWith({ to: '/' });
    expect(signInOtpMock).toHaveBeenCalledTimes(1);
  });

  it('signs in from the button too', async () => {
    signInOtpMock.mockResolvedValue({
      data: null,
      error: { code: 'INVALID_OTP' },
    });
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);
    await user.type(screen.getByLabelText(/sign-in code/i), '12345678');
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => {
      expect(signInOtpMock).toHaveBeenCalledTimes(2);
    });
  });

  it('shows the digits as two groups of four and drops anything else', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);
    const field = screen.getByLabelText(/sign-in code/i);

    await user.type(field, '12a3-45');

    expect(field).toHaveValue('1234 5');
    expect(signInOtpMock).not.toHaveBeenCalled();
  });

  it('keeps the caret after the digit it followed when editing mid-code', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);
    const field = screen.getByLabelText<HTMLInputElement>(/sign-in code/i);
    await user.type(field, '123567');

    await user.type(field, '4', {
      initialSelectionStart: 3,
      initialSelectionEnd: 3,
    });

    expect(field).toHaveValue('1234 567');
    expect(field.selectionStart).toBe(4);
  });

  it('does not send the code again when more digits are typed', async () => {
    signInOtpMock.mockResolvedValue({
      data: null,
      error: { code: 'INVALID_OTP' },
    });
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);
    const field = screen.getByLabelText(/sign-in code/i);
    await user.type(field, '12345678');
    await screen.findByRole('alert');

    await user.type(field, '9', {
      initialSelectionStart: 9,
      initialSelectionEnd: 9,
    });

    expect(field).toHaveValue('1234 5678');
    expect(signInOtpMock).toHaveBeenCalledTimes(1);
  });

  it('selects a rejected code so the next one replaces it', async () => {
    signInOtpMock.mockResolvedValue({
      data: null,
      error: { code: 'INVALID_OTP' },
    });
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);
    const field = screen.getByLabelText<HTMLInputElement>(/sign-in code/i);
    await user.type(field, '12345678');
    await screen.findByRole('alert');

    await waitFor(() => {
      expect(field).toHaveFocus();
    });
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 9]);
  });

  it('moves focus to the code field', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);

    await waitFor(() => {
      expect(screen.getByLabelText(/sign-in code/i)).toHaveFocus();
    });
  });

  it.each([' 1234 5678 ', 'Code: 1234-5678'])(
    'signs in with a pasted %j',
    async (pasted) => {
      signInOtpMock.mockResolvedValue({ data: {}, error: null });
      const user = userEvent.setup();
      render(<SignInPage />);
      await requestCode(user);

      await user.click(screen.getByLabelText(/sign-in code/i));
      await user.paste(pasted);

      await waitFor(() => {
        expect(signInOtpMock).toHaveBeenCalledWith({
          email: 'cook@example.com',
          otp: '12345678',
        });
      });
    },
  );

  it('rejects a code that is not 8 digits without calling sign-in', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);

    await user.type(screen.getByLabelText(/sign-in code/i), '12');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/8-digit code/i);
    expect(signInOtpMock).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_OTP', /isn’t right/i],
    ['OTP_EXPIRED', /has expired/i],
    ['TOO_MANY_ATTEMPTS', /too many wrong tries/i],
  ])('explains a %s rejection', async (code, message) => {
    signInOtpMock.mockResolvedValue({ data: null, error: { code } });
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);

    await user.type(screen.getByLabelText(/sign-in code/i), '12345678');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(navigateMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByLabelText(/sign-in code/i)).toHaveFocus();
    });
  });

  it('sends a new code on request', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);

    await user.click(screen.getByRole('button', { name: /send a new code/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      /we sent a new code/i,
    );
    expect(sendCodeMock).toHaveBeenCalledTimes(2);
  });

  it('shows why a new code could not be sent', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);
    sendCodeMock.mockResolvedValue('Too many attempts. Try again later.');

    await user.click(screen.getByRole('button', { name: /send a new code/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /too many attempts/i,
    );
  });

  it('goes back to the email step to use a different address', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await requestCode(user);

    await user.click(
      screen.getByRole('button', { name: /use a different email/i }),
    );

    expect(screen.getByRole('heading', { name: /^sign in$/i })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toHaveFocus();
    });
  });
});

describe('SignInPage deletion banner', () => {
  it('shows the "Your account has been deleted" banner when justDeleted is true', () => {
    render(<SignInPage justDeleted />);
    expect(screen.getByRole('status')).toHaveTextContent(
      /your account has been deleted/i,
    );
  });

  it('omits the deletion banner on a normal visit', () => {
    render(<SignInPage />);
    expect(
      screen.queryByText(/your account has been deleted/i),
    ).not.toBeInTheDocument();
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
