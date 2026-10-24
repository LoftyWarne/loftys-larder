import { signInSchema, type SignInInput } from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { redirect, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { SignInCodeForm } from '@/components/sign-in-code-form.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { authClient, sendSignInCode } from '@/lib/auth-client.ts';

// Surfaces the deletion-complete banner — set by the Settings page after a
// successful `user.deleteAccount` mutation. `.optional().catch(undefined)`
// keeps unrelated visits to /sign-in immune to malformed search input.
export const signInSearchSchema = z.object({
  deleted: z.literal('1').optional().catch(undefined),
});

export type SignInSearch = z.infer<typeof signInSearchSchema>;

export async function signInBeforeLoad(): Promise<void> {
  const { data } = await authClient.getSession();
  if (data) {
    throw redirect({ to: '/' });
  }
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'sent'; email: string }
  | { kind: 'error'; message: string };

export interface SignInPageProps {
  justDeleted?: boolean;
}

export function SignInPage({
  justDeleted = false,
}: SignInPageProps = {}): React.ReactElement {
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const form = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '' },
  });

  const navigate = useNavigate();
  const { setFocus } = form;
  const changingEmail = useRef(false);

  // Coming back from the code step, put focus where the user will type.
  useEffect(() => {
    if (state.kind === 'idle' && changingEmail.current) {
      changingEmail.current = false;
      setFocus('email');
    }
  }, [state.kind, setFocus]);

  const submit = form.handleSubmit(async ({ email }) => {
    setState({ kind: 'submitting' });
    const message = await sendSignInCode(email);
    setState(
      message === null ? { kind: 'sent', email } : { kind: 'error', message },
    );
  });

  if (state.kind === 'sent') {
    return (
      <section className="mx-auto max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <SignInCodeForm
          email={state.email}
          onSignedIn={() => navigate({ to: '/' })}
          onChangeEmail={() => {
            changingEmail.current = true;
            setState({ kind: 'idle' });
          }}
        />
      </section>
    );
  }

  const submitting = state.kind === 'submitting';

  return (
    <section className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {justDeleted && (
        <p
          role="status"
          className="rounded-md border border-border bg-muted p-3 text-sm"
        >
          Your account has been deleted.
        </p>
      )}
      <p>Enter your email and we&apos;ll send you a sign-in code.</p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        className="space-y-3"
        noValidate
      >
        <div className="space-y-1">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            disabled={submitting}
            aria-invalid={form.formState.errors.email ? true : undefined}
            {...form.register('email')}
          />
          {form.formState.errors.email && (
            <p role="alert" className="text-sm text-destructive">
              {form.formState.errors.email.message}
            </p>
          )}
        </div>
        {state.kind === 'error' && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send sign-in code'}
        </Button>
      </form>
    </section>
  );
}
