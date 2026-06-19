import {
  themePreferenceSchema,
  updateProfileInputSchema,
  type ThemePreference,
  type UpdateProfileInput,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { DangerConfirmDialog } from '@/components/danger-confirm-dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { authClient, refreshSession } from '@/lib/auth-client.ts';
import { trpc } from '@/lib/trpc.ts';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

const THEME_OPTIONS: readonly {
  value: ThemePreference;
  label: string;
  hint: string;
}[] = [
  { value: 'system', label: 'System', hint: 'Follow your device setting' },
  { value: 'light', label: 'Light', hint: 'Always light' },
  { value: 'dark', label: 'Dark', hint: 'Always dark' },
];

export function SettingsPage(): React.ReactElement {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const meQuery = trpc.user.getMe.useQuery();
  const deletionSummaryQuery = trpc.user.getDeletionSummary.useQuery();
  const updateProfile = trpc.user.updateProfile.useMutation({
    onSuccess: async () => {
      await utils.user.getMe.invalidate();
      refreshSession();
    },
  });
  const deleteAccount = trpc.user.deleteAccount.useMutation();

  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const form = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileInputSchema),
    defaultValues: { name: '', themePreference: 'system' },
  });

  useEffect(() => {
    if (!meQuery.data) return;
    form.reset({
      name: meQuery.data.name,
      themePreference: meQuery.data.themePreference,
    });
  }, [meQuery.data, form]);

  const submit = form.handleSubmit(async (values) => {
    if (!meQuery.data) return;
    const patch: UpdateProfileInput = {};
    const trimmedName = values.name?.trim() ?? '';
    if (trimmedName && trimmedName !== meQuery.data.name) {
      patch.name = trimmedName;
    }
    if (
      values.themePreference &&
      values.themePreference !== meQuery.data.themePreference
    ) {
      patch.themePreference = values.themePreference;
    }
    if (Object.keys(patch).length === 0) {
      setSave({ kind: 'saved' });
      return;
    }
    setSave({ kind: 'saving' });
    try {
      await updateProfile.mutateAsync(patch);
      setSave({ kind: 'saved' });
    } catch (error) {
      setSave({
        kind: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not save your profile.',
      });
    }
  });

  if (meQuery.isLoading) {
    return (
      <section className="mx-auto max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p role="status">Loading your profile…</p>
      </section>
    );
  }

  if (meQuery.error) {
    return (
      <section className="mx-auto max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p role="alert" className="text-sm text-destructive">
          Could not load your profile: {meQuery.error.message}
        </p>
      </section>
    );
  }

  if (!meQuery.data) {
    return (
      <section className="mx-auto max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p role="status">Loading your profile…</p>
      </section>
    );
  }

  const me = meQuery.data;
  const saving = save.kind === 'saving';
  const currentTheme = form.watch('themePreference') ?? 'system';

  return (
    <section className="mx-auto max-w-md space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        className="space-y-6"
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

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Theme</legend>
          <div
            role="radiogroup"
            aria-label="Theme preference"
            className="space-y-2"
          >
            {THEME_OPTIONS.map((option) => {
              const id = `theme-${option.value}`;
              const checked =
                themePreferenceSchema.parse(currentTheme) === option.value;
              return (
                <label
                  key={option.value}
                  htmlFor={id}
                  className="flex cursor-pointer items-start gap-3 rounded-md border border-input p-3 text-sm hover:bg-accent"
                >
                  <input
                    id={id}
                    type="radio"
                    value={option.value}
                    checked={checked}
                    disabled={saving}
                    onChange={() => {
                      form.setValue('themePreference', option.value, {
                        shouldDirty: true,
                      });
                    }}
                    className="mt-1"
                  />
                  <span className="flex flex-col">
                    <span className="font-medium">{option.label}</span>
                    <span className="text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {save.kind === 'error' && (
          <p role="alert" className="text-sm text-destructive">
            {save.message}
          </p>
        )}
        {save.kind === 'saved' && (
          <p role="status" className="text-sm text-muted-foreground">
            Saved.
          </p>
        )}

        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </form>

      <DangerZone
        email={me.email}
        summary={deletionSummaryQuery.data}
        summaryLoading={deletionSummaryQuery.isLoading}
        open={deleteOpen}
        onOpenChange={(next) => {
          setDeleteOpen(next);
          if (!next) setDeleteError(null);
        }}
        pending={deleteAccount.isPending}
        errorMessage={deleteError}
        onConfirm={async () => {
          setDeleteError(null);
          try {
            await deleteAccount.mutateAsync({
              emailConfirmation: me.email,
            });
            // Best-effort: session is already cascade-deleted server-side, but
            // signOut clears the cached React-Query session so the redirect
            // doesn't flash a stale signed-in state.
            await authClient.signOut().catch(() => {
              /* ignore — session is gone server-side regardless */
            });
            await navigate({ to: '/sign-in', search: { deleted: '1' } });
          } catch (error) {
            setDeleteError(
              error instanceof Error
                ? error.message
                : 'Could not delete your account. Try again.',
            );
          }
        }}
      />
    </section>
  );
}

interface DangerZoneProps {
  email: string;
  summary:
    | { commentCount: number; recipeCount: number; planCount: number }
    | undefined;
  summaryLoading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  errorMessage: string | null;
  onConfirm: () => Promise<void>;
}

function DangerZone({
  email,
  summary,
  summaryLoading,
  open,
  onOpenChange,
  pending,
  errorMessage,
  onConfirm,
}: DangerZoneProps): React.ReactElement {
  return (
    <section
      aria-labelledby="danger-zone-heading"
      className="space-y-3 rounded-md border border-destructive/40 p-4"
    >
      <div className="space-y-1">
        <h2
          id="danger-zone-heading"
          className="text-base font-semibold text-destructive"
        >
          Danger zone
        </h2>
        <p className="text-sm text-muted-foreground">
          Deleting your account is permanent. Shared records stay in your
          household but lose your name from them.
        </p>
      </div>
      {summaryLoading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      )}
      {summary && (
        <ul className="text-sm text-muted-foreground">
          <li>
            {summary.commentCount} comment
            {summary.commentCount === 1 ? '' : 's'} will become “[deleted
            user]”.
          </li>
          <li>
            {summary.recipeCount} recipe{summary.recipeCount === 1 ? '' : 's'}{' '}
            you added will lose your name.
          </li>
          <li>
            {summary.planCount} meal plan{summary.planCount === 1 ? '' : 's'}{' '}
            you created will lose your name.
          </li>
        </ul>
      )}
      <Button
        type="button"
        variant="destructive"
        onClick={() => {
          onOpenChange(true);
        }}
      >
        Delete account
      </Button>
      <DangerConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Delete your account?"
        description={
          <>
            <p>
              This action is permanent. Your ratings and in-progress recipe
              drafts will be deleted. Comments, recipes, and meal plans you
              created will stay in your household but show “[deleted user]”
              instead of your name.
            </p>
            <p>
              Type <strong>{email}</strong> below to confirm.
            </p>
          </>
        }
        confirmationText={email}
        confirmationLabel="Your email"
        confirmLabel="Delete account"
        pendingLabel="Deleting…"
        pending={pending}
        errorMessage={errorMessage}
        onConfirm={onConfirm}
      />
    </section>
  );
}
