import {
  SIGN_IN_CODE_LENGTH,
  groupSignInCode,
  signInCodeDigits,
  signInCodeSchema,
  type SignInCodeInput,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
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
  // isSubmitting only updates on the next render, too late to stop an
  // auto-submit landing while a click's submit is already running.
  const inFlight = useRef(false);

  const submitting = form.formState.isSubmitting;

  // The step replaces the email form, and the field is disabled while a code
  // is checked; either way focus would otherwise fall to <body>. After a
  // rejected code the text is selected so the next code replaces it.
  useEffect(() => {
    if (!submitting) setFocus('code', { shouldSelect: submitError !== null });
  }, [setFocus, submitting, submitError]);

  const submit = form.handleSubmit(async ({ code }) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitError(null);
    try {
      const { error } = await authClient.signIn.emailOtp({ email, otp: code });
      if (error) {
        setSubmitError(
          signInErrorMessage(error, 'Could not sign you in. Try again.'),
        );
        return;
      }
      await onSignedIn();
    } finally {
      inFlight.current = false;
    }
  });

  const codeField = form.register('code');

  // Keeps only digits (so a pasted "Code: 1234 5678" works), shows them as
  // "1234 5678", and keeps the caret after the same digit it followed.
  // Submits as soon as the eighth digit arrives, which is what makes an
  // autofilled code sign straight in.
  const onCodeChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const input = event.target;
    const before = form.getValues('code');
    const digitsBeforeCaret = signInCodeDigits(
      input.value.slice(0, input.selectionStart ?? input.value.length),
    ).length;
    const digits = signInCodeDigits(input.value);
    const grouped = groupSignInCode(digits);
    input.value = grouped;
    const caret =
      digitsBeforeCaret > 4 ? digitsBeforeCaret + 1 : digitsBeforeCaret;
    input.setSelectionRange(caret, caret);
    void codeField.onChange(event);
    if (
      digits.length === SIGN_IN_CODE_LENGTH &&
      signInCodeDigits(before) !== digits
    ) {
      void submit();
    }
  };

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
          pattern="[0-9 ]*"
          autoComplete="one-time-code"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder="0000 0000"
          disabled={submitting}
          aria-invalid={codeError ? true : undefined}
          aria-describedby={codeError ? 'sign-in-code-error' : undefined}
          className="h-12 max-w-[14ch] text-center font-mono text-xl tracking-widest tabular-nums"
          {...codeField}
          onChange={onCodeChange}
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
