import { setNameInputSchema, type SetNameInput } from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { redirect, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { authClient, refreshSession } from '@/lib/auth-client.ts';
import { trpc } from '@/lib/trpc.ts';

// Sends users without a session to /sign-in, and users who already have a name
// straight to the app. The authed gate sends here in the inverse case (blank
// name), so the two never loop.
export async function welcomeBeforeLoad(): Promise<void> {
  const { data } = await authClient.getSession();
  if (!data) {
    throw redirect({ to: '/sign-in' });
  }
  if (data.user.name.trim() !== '') {
    throw redirect({ to: '/' });
  }
}

export function WelcomePage(): React.ReactElement {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const updateProfile = trpc.user.updateProfile.useMutation({
    onSuccess: async () => {
      await utils.user.getMe.invalidate();
      refreshSession();
    },
  });
  const [error, setError] = useState<string | null>(null);

  const form = useForm<SetNameInput>({
    resolver: zodResolver(setNameInputSchema),
    defaultValues: { name: '' },
  });

  const submit = form.handleSubmit(async ({ name }) => {
    setError(null);
    try {
      await updateProfile.mutateAsync({ name });
      await navigate({ to: '/' });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not save your name. Try again.',
      );
    }
  });

  const saving = form.formState.isSubmitting;

  return (
    <section className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold">Welcome to Lofty&apos;s Larder</h1>
      <p>
        What should we call you? This is the name other people in your household
        will see.
      </p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        className="space-y-3"
        noValidate
      >
        <div className="space-y-1">
          <label htmlFor="name" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="name"
            type="text"
            autoComplete="name"
            autoFocus
            disabled={saving}
            aria-invalid={form.formState.errors.name ? true : undefined}
            {...form.register('name')}
          />
          {form.formState.errors.name && (
            <p role="alert" className="text-sm text-destructive">
              {form.formState.errors.name.message}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Continue'}
        </Button>
      </form>
    </section>
  );
}
