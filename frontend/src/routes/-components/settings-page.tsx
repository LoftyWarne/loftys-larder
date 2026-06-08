import {
  themePreferenceSchema,
  updateProfileInputSchema,
  type ThemePreference,
  type UpdateProfileInput,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
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
  const meQuery = trpc.user.getMe.useQuery();
  const updateProfile = trpc.user.updateProfile.useMutation({
    onSuccess: async () => {
      await utils.user.getMe.invalidate();
    },
  });

  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

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
    </section>
  );
}
