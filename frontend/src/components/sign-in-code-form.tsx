import { signInCodeSchema, type SignInCodeInput } from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import {
  authClient,
  sendSignInCode,
  signInErrorMessage,
} from '@/lib/auth-client.ts';

type ResendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

export interface SignInCodeFormProps {
  email: string;
  onSignedIn: () => void | Promise<void>;
  onChangeEmail?: () => void;
}

export function SignInCodeForm({
  email,
  onSignedIn,
  onChangeEmail,
}: SignInCodeFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [resend, setResend] = useState<ResendState>({ kind: 'idle' });
  const form = useForm<SignInCodeInput>({
    resolver: zodResolver(signInCodeSchema),
    defaultValues: { code: '' },
  });
  const { setFocus } = form;

  const submitting = form.formState.isSubmitting;

  // The step replaces the email form, and the field is disabled while a code
  // is checked; either way focus would otherwise fall to <body>.
  useEffect(() => {
    if (!submitting) setFocus('code');
  }, [setFocus, submitting, submitError]);

  const submit = form.handleSubmit(async ({ code }) => {
    setSubmitError(null);
    const { error } = await authClient.signIn.emailOtp({ email, otp: code });
    if (error) {
      setSubmitError(
        signInErrorMessage(error, 'Could not sign you in. Try again.'),
      );
      return;
    }
    await onSignedIn();
  });

  const resendCode = async (): Promise<void> => {
    setResend({ kind: 'sending' });
    setSubmitError(null);
    const message = await sendSignInCode(email);
    if (message === null) form.reset({ code: '' });
    setResend(message === null ? { kind: 'sent' } : { kind: 'error', message });
  };

  const codeError = form.formState.errors.code?.message ?? submitError;

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="space-y-3"
      noValidate
    >
      <p>
        We sent an 8-digit code to <strong>{email}</strong>. It expires in 10
        minutes.
      </p>
      <div className="space-y-1">
        <label htmlFor="sign-in-code" className="text-sm font-medium">
          Sign-in code
        </label>
        <Input
          id="sign-in-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          disabled={submitting}
          aria-invalid={codeError ? true : undefined}
          aria-describedby={codeError ? 'sign-in-code-error' : undefined}
          {...form.register('code')}
        />
        {codeError && (
          <p
            id="sign-in-code-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {codeError}
          </p>
        )}
      </div>
      <Button type="submit" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          disabled={resend.kind === 'sending'}
          onClick={() => {
            void resendCode();
          }}
        >
          {resend.kind === 'sending' ? 'Sending…' : 'Send a new code'}
        </Button>
        {onChangeEmail && (
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={onChangeEmail}
          >
            Use a different email
          </Button>
        )}
      </div>
      {resend.kind === 'sent' && (
        <p role="status" className="text-sm text-muted-foreground">
          We sent a new code. Earlier codes no longer work.
        </p>
      )}
      {resend.kind === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {resend.message}
        </p>
      )}
    </form>
  );
}
