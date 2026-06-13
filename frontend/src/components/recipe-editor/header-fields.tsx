import {
  createRecipeInputSchema,
  type CreateRecipeInput,
  type RecipeReferenceItem,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm, type UseFormRegister } from 'react-hook-form';

import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';

type HeaderFormValues = CreateRecipeInput;

const headerResolverSchema = createRecipeInputSchema;

export interface HeaderFieldsProps {
  mode: 'create' | 'edit';
  defaultValues: HeaderFormValues;
  sources: readonly RecipeReferenceItem[];
  onSubmit: (values: HeaderFormValues) => Promise<void>;
  submitLabel?: string;
  savedNoticeKey?: number;
}

const FALLBACK_SOURCE_NONE_ID = '';

export function HeaderFields({
  mode,
  defaultValues,
  sources,
  onSubmit,
  submitLabel,
  savedNoticeKey,
}: HeaderFieldsProps): React.ReactElement {
  // Same validation surface for both modes — the form always carries every
  // field (defaults from server on edit, blanks on create). The page is
  // responsible for diffing edit-mode submissions into a patch.
  const form = useForm<HeaderFormValues>({
    resolver: zodResolver(headerResolverSchema),
    defaultValues,
  });

  useEffect(() => {
    form.reset(defaultValues);
  }, [defaultValues, form]);

  const submitting = form.formState.isSubmitting;
  const errors = form.formState.errors;
  const register = form.register;

  const submit = form.handleSubmit(async (values) => {
    await onSubmit(values);
  });

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="space-y-4"
      noValidate
      aria-labelledby="recipe-header-heading"
    >
      <h2 id="recipe-header-heading" className="text-lg font-semibold">
        Details
      </h2>

      <FieldText
        id="recipe-name"
        label="Name"
        autoFocus
        disabled={submitting}
        register={register('name')}
        error={errors.name?.message}
      />

      <div className="space-y-1">
        <label htmlFor="recipe-description" className="text-sm font-medium">
          Description
        </label>
        <textarea
          id="recipe-description"
          rows={3}
          disabled={submitting}
          className="flex w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          {...register('description', {
            setValueAs: (value) =>
              value === '' || value === null ? null : String(value),
          })}
        />
        {errors.description?.message && (
          <p role="alert" className="text-sm text-destructive">
            {errors.description.message}
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <FieldNumber
          id="recipe-servings"
          label="Servings"
          min={1}
          required
          disabled={submitting}
          register={register('baseServings', {
            setValueAs: (value) =>
              value === '' || value === null ? null : Number(value),
          })}
          error={errors.baseServings?.message}
        />
        <FieldNumber
          id="recipe-active-time"
          label="Active mins"
          min={0}
          disabled={submitting}
          register={register('activeTimeMins', {
            setValueAs: (value) =>
              value === '' || value === null ? null : Number(value),
          })}
          error={errors.activeTimeMins?.message}
        />
        <FieldNumber
          id="recipe-total-time"
          label="Total mins"
          min={0}
          disabled={submitting}
          register={register('totalTimeMins', {
            setValueAs: (value) =>
              value === '' || value === null ? null : Number(value),
          })}
          error={errors.totalTimeMins?.message}
        />
      </div>

      <FieldText
        id="recipe-source-url"
        label="Source URL"
        type="url"
        disabled={submitting}
        register={register('sourceUrl', {
          setValueAs: (value) =>
            value === '' || value === null ? null : String(value),
        })}
        error={errors.sourceUrl?.message}
      />

      {sources.length > 0 && (
        <div className="space-y-1">
          <label htmlFor="recipe-source" className="text-sm font-medium">
            Source
          </label>
          <select
            id="recipe-source"
            disabled={submitting}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            {...register('sourceId', {
              setValueAs: (value) =>
                value === FALLBACK_SOURCE_NONE_ID || value === null
                  ? null
                  : Number(value),
            })}
          >
            <option value={FALLBACK_SOURCE_NONE_ID}>— No source —</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {mode === 'create' && (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            disabled={submitting}
            {...register('isBase')}
          />
          <span>This is a base recipe (batch-cookable)</span>
        </label>
      )}

      <SavedNotice key={savedNoticeKey} show={savedNoticeKey !== undefined} />

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : (submitLabel ?? 'Save details')}
        </Button>
      </div>
    </form>
  );
}

interface FieldTextProps {
  id: string;
  label: string;
  type?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  register: ReturnType<UseFormRegister<HeaderFormValues>>;
  error?: string;
}

function FieldText({
  id,
  label,
  type = 'text',
  autoFocus,
  disabled,
  register,
  error,
}: FieldTextProps): React.ReactElement {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type={type}
        autoFocus={autoFocus}
        autoComplete="off"
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        {...register}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

interface FieldNumberProps {
  id: string;
  label: string;
  min?: number;
  required?: boolean;
  disabled?: boolean;
  register: ReturnType<UseFormRegister<HeaderFormValues>>;
  error?: string;
}

function FieldNumber({
  id,
  label,
  min,
  required,
  disabled,
  register,
  error,
}: FieldNumberProps): React.ReactElement {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && ' *'}
      </label>
      <Input
        id={id}
        type="number"
        min={min}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        {...register}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function SavedNotice({ show }: { show: boolean }): React.ReactElement | null {
  if (!show) return null;
  return (
    <p role="status" className="text-sm text-emerald-600">
      Saved.
    </p>
  );
}

export type { HeaderFormValues };
