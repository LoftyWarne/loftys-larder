import { signInSchema, type SignInInput } from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { authClient } from '@/lib/auth-client.ts';

export async function signInBeforeLoad(): Promise<void> {
  const { data } = await authClient.getSession();
  if (data) {
    throw redirect({ to: '/' });
  }
}

export const Route = createFileRoute('/sign-in')({
  beforeLoad: signInBeforeLoad,
  component: SignInPage,
});

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'sent'; email: string }
  | { kind: 'error'; message: string };

export function SignInPage(): React.ReactElement {
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const form = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '' },
  });

  const submit = form.handleSubmit(async ({ email }) => {
    setState({ kind: 'submitting' });
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: '/',
      errorCallbackURL: '/auth/verify',
    });
    if (error) {
      setState({
        kind: 'error',
        message: error.message ?? 'Could not send the magic link. Try again.',
      });
      return;
    }
    setState({ kind: 'sent', email });
  });

  if (state.kind === 'sent') {
    return (
      <section className="mx-auto max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <p>
          We sent a sign-in link to <strong>{state.email}</strong>. Open it on
          any device to finish signing in.
        </p>
        <p className="text-sm text-muted-foreground">
          The link expires in 10 minutes.
        </p>
      </section>
    );
  }

  const submitting = state.kind === 'submitting';

  return (
    <section className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p>Enter your email and we&apos;ll send you a sign-in link.</p>
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
          {submitting ? 'Sending…' : 'Send sign-in link'}
        </Button>
      </form>
    </section>
  );
}
