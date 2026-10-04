import {
  createRecipeInputSchema,
  recipeSourceNameSchema,
  type CreateRecipeInput,
  type RecipeReferenceItem,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useForm, type UseFormRegister } from 'react-hook-form';

import { NewBadge } from '@/components/recipe-editor/review-badges.tsx';
import type { RecipeSectionHandle } from '@/components/recipe-editor/section-handle.ts';
import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import { NUTRITION_FIELDS } from '@/lib/nutrition.ts';

type HeaderFormValues = CreateRecipeInput;

const headerResolverSchema = createRecipeInputSchema;

export interface HeaderFieldsProps {
  // `import` is Import Review: no base-recipe toggle (DEC-103) and no
  // autofocus, so the cook starts at the top of the page.
  mode: 'create' | 'edit' | 'import';
  defaultValues: HeaderFormValues;
  sources: readonly RecipeReferenceItem[];
  // Resolves `true` when the recipe was saved (or had no changes to save) and
  // `false` when the save was rejected, so the "Save & Finish" flow can tell
  // whether it may navigate away.
  onSubmit: (values: HeaderFormValues) => Promise<boolean>;
  // Creates a new household source from the combobox's "Create …" action and
  // resolves to the created reference. Omit to disable inline source creation
  // (the combobox then only selects existing sources).
  createSource?: (name: string) => Promise<RecipeReferenceItem>;
  submitLabel?: string;
  savedNoticeKey?: number;
  // Fires on every form value change. Used by the draft autosave hook —
  // omit it and the form behaves exactly as before.
  onValuesChange?: (values: HeaderFormValues) => void;
  // A note under a field (an Estimate mark in Import Review).
  fieldNotes?: Partial<Record<keyof HeaderFormValues, ReactNode>>;
  // Import Review: a proposed new source, held by name and created with the
  // recipe (DEC-105). When `onProposedSourceNameChange` is set, "Create …"
  // proposes a source instead of creating one.
  proposedSourceName?: string | null;
  onProposedSourceNameChange?: (name: string | null) => void;
  // Import Review: the nutrition "Estimated" box follows the Estimate marks
  // rather than the form field (DEC-106).
  nutritionEstimated?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
  hideSaveButton?: boolean;
}

type SourceOption = SearchableComboboxOption;

export const HeaderFields = forwardRef<RecipeSectionHandle, HeaderFieldsProps>(
  function HeaderFields(
    {
      mode,
      defaultValues,
      sources,
      onSubmit,
      createSource,
      submitLabel,
      savedNoticeKey,
      onValuesChange,
      fieldNotes,
      proposedSourceName = null,
      onProposedSourceNameChange,
      nutritionEstimated,
      hideSaveButton = false,
    },
    ref,
  ): React.ReactElement {
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

    // The "Saved." notice is shown after a save, then cleared the moment the
    // user edits a field again — a stale "Saved." next to unsaved changes is
    // misleading. A new `savedNoticeKey` (bumped by the page on every save)
    // turns it back on; the watch below turns it off. `type === 'change'` fires
    // only for real user input — the post-save `form.reset` fires with an
    // undefined type, so it doesn't wipe a freshly-shown notice.
    const [savedVisible, setSavedVisible] = useState(false);
    useEffect(() => {
      if (savedNoticeKey === undefined) return;
      setSavedVisible(true);
    }, [savedNoticeKey]);

    useEffect(() => {
      const subscription = form.watch((values, { type }) => {
        if (type === 'change') setSavedVisible(false);
        onValuesChange?.(values as HeaderFormValues);
      });
      return () => {
        subscription.unsubscribe();
      };
    }, [form, onValuesChange]);

    const submitting = form.formState.isSubmitting;
    const errors = form.formState.errors;
    const register = form.register;

    // Locally-created sources are merged with the server list so a just-created
    // source resolves to its label before the parent's references query
    // refetches.
    const [createdSources, setCreatedSources] = useState<SourceOption[]>([]);
    const [sourceCreateError, setSourceCreateError] = useState<string>();
    // Bumped to remount the combobox, clearing unmatched typed text after a
    // failed create.
    const [sourceComboboxKey, setSourceComboboxKey] = useState(0);

    const sourceOptions = useMemo<SourceOption[]>(() => {
      const merged: SourceOption[] = sources.map((s) => ({
        id: s.id,
        label: s.name,
      }));
      for (const created of createdSources) {
        if (!merged.some((o) => o.id === created.id)) merged.push(created);
      }
      return merged;
    }, [sources, createdSources]);

    const selectedSourceId = form.watch('sourceId') ?? null;
    const selectedSource =
      selectedSourceId === null
        ? null
        : (sourceOptions.find((o) => o.id === selectedSourceId) ?? null);

    const searchSources = useCallback(
      (query: string): SourceOption[] => {
        const trimmed = query.trim().toLowerCase();
        if (trimmed === '') return sourceOptions;
        return sourceOptions.filter((o) =>
          o.label.toLowerCase().includes(trimmed),
        );
      },
      [sourceOptions],
    );

    const handleSourceCreate = useCallback(
      (name: string): void => {
        if (!createSource) return;
        setSourceCreateError(undefined);
        void createSource(name)
          .then((created) => {
            setCreatedSources((prev) =>
              prev.some((o) => o.id === created.id)
                ? prev
                : [...prev, { id: created.id, label: created.name }],
            );
            // `setValue` doesn't emit a `'change'` watch event; clear directly.
            setSavedVisible(false);
            form.setValue('sourceId', created.id, { shouldDirty: true });
          })
          .catch((error: unknown) => {
            if (getDomainErrorCode(error) === 'SOURCE_NAME_TAKEN') {
              setSourceCreateError('A source with this name already exists');
              setSourceComboboxKey((k) => k + 1);
              return;
            }
            throw error;
          });
      },
      [createSource, form],
    );

    const proposeSource = useCallback(
      (name: string): void => {
        if (!onProposedSourceNameChange) return;
        setSourceCreateError(undefined);
        setSavedVisible(false);
        form.setValue('sourceId', null, { shouldDirty: true });
        onProposedSourceNameChange(name);
      },
      [form, onProposedSourceNameChange],
    );

    const proposedSourceProblem = useCallback((): string | null => {
      if (proposedSourceName === null) return null;
      const parsed = recipeSourceNameSchema.safeParse(proposedSourceName);
      if (parsed.success) return null;
      return parsed.error.issues[0]?.message ?? 'Check the source name';
    }, [proposedSourceName]);

    const submit = form.handleSubmit(async (values) => {
      await onSubmit(values);
    });

    // Validate and save imperatively for the page's "Save & Finish" button.
    // Resolves `false` when validation fails so the page can stop navigating.
    const runSubmit = useCallback(
      () =>
        new Promise<boolean>((resolve) => {
          const sourceProblem = proposedSourceProblem();
          setSourceCreateError(sourceProblem ?? undefined);
          void form.handleSubmit(
            async (values) => {
              if (sourceProblem !== null) {
                resolve(false);
                return;
              }
              resolve(await onSubmit(values));
            },
            () => {
              resolve(false);
            },
          )();
        }),
      [form, onSubmit, proposedSourceProblem],
    );

    useImperativeHandle(ref, () => ({ submit: runSubmit }), [runSubmit]);

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
          autoFocus={mode !== 'import'}
          disabled={submitting}
          register={register('name')}
          error={errors.name?.message}
          note={fieldNotes?.name}
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
            aria-describedby={
              fieldNotes?.description ? 'recipe-description-note' : undefined
            }
            {...register('description', {
              setValueAs: (value) =>
                value === '' || value === null ? null : String(value),
            })}
          />
          {fieldNotes?.description && (
            <div id="recipe-description-note">{fieldNotes.description}</div>
          )}
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
            note={fieldNotes?.baseServings}
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
            note={fieldNotes?.activeTimeMins}
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
            note={fieldNotes?.totalTimeMins}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="recipe-source" className="text-sm font-medium">
            Source
          </label>
          {proposedSourceName !== null && onProposedSourceNameChange ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <NewBadge />
                <Input
                  id="recipe-source"
                  type="text"
                  autoComplete="off"
                  aria-describedby="recipe-source-new-hint"
                  disabled={submitting}
                  value={proposedSourceName}
                  onChange={(event) => {
                    setSourceCreateError(undefined);
                    onProposedSourceNameChange(event.target.value);
                  }}
                />
              </div>
              <p
                id="recipe-source-new-hint"
                className="text-xs text-muted-foreground"
              >
                Added to your sources when you create the recipe.
              </p>
              <SearchableCombobox<SourceOption>
                value={null}
                onChange={(option) => {
                  if (!option) return;
                  setSourceCreateError(undefined);
                  setSavedVisible(false);
                  form.setValue('sourceId', option.id, { shouldDirty: true });
                  onProposedSourceNameChange(null);
                }}
                searchQuery={searchSources}
                placeholder="Or use an existing source"
                ariaLabel="Use an existing source"
                disabled={submitting}
                emptyMessage="No matching sources"
              />
            </div>
          ) : (
            <SearchableCombobox<SourceOption>
              key={sourceComboboxKey}
              id="recipe-source"
              value={selectedSource}
              onChange={(option) => {
                setSourceCreateError(undefined);
                // `setValue` doesn't emit a `'change'` watch event, so clear
                // the saved notice here as the watch subscription won't.
                setSavedVisible(false);
                form.setValue('sourceId', option?.id ?? null, {
                  shouldDirty: true,
                });
              }}
              searchQuery={searchSources}
              placeholder="Cookbook, website, person…"
              ariaLabel="Source"
              disabled={submitting}
              emptyMessage="No matching sources"
              onCreate={
                onProposedSourceNameChange
                  ? proposeSource
                  : createSource
                    ? handleSourceCreate
                    : undefined
              }
              createLabel={(query) =>
                onProposedSourceNameChange
                  ? `New source “${query}”`
                  : `Create source “${query}”`
              }
            />
          )}
          {sourceCreateError && (
            <p role="alert" className="text-sm text-destructive">
              {sourceCreateError}
            </p>
          )}
        </div>

        <FieldText
          id="recipe-source-detail"
          label="Source detail"
          placeholder="e.g. p.142, via Aunt Sally"
          disabled={submitting}
          register={register('sourceDetail', {
            setValueAs: (value) =>
              value === '' || value === null ? null : String(value),
          })}
          error={errors.sourceDetail?.message}
          note={fieldNotes?.sourceDetail}
        />

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
          note={fieldNotes?.sourceUrl}
        />

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Nutrition per serving</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {NUTRITION_FIELDS.map((field) => (
              <FieldNumber
                key={field.key}
                id={`recipe-${field.slug}`}
                label={`${field.label} (${field.unit})`}
                min={0}
                step={field.unit === 'kcal' ? '1' : '0.01'}
                inputMode={field.unit === 'kcal' ? 'numeric' : 'decimal'}
                disabled={submitting}
                register={register(field.key, {
                  setValueAs: (value) =>
                    value === '' || value === null ? null : Number(value),
                })}
                error={errors[field.key]?.message}
                note={fieldNotes?.[field.key]}
              />
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            {nutritionEstimated ? (
              <input
                type="checkbox"
                disabled={submitting}
                checked={nutritionEstimated.checked}
                onChange={(event) => {
                  nutritionEstimated.onChange(event.target.checked);
                }}
              />
            ) : (
              <input
                type="checkbox"
                disabled={submitting}
                {...register('nutritionIsEstimated')}
              />
            )}
            <span>Estimated</span>
          </label>
        </fieldset>

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

        <SavedNotice key={savedNoticeKey} show={savedVisible} />

        {!hideSaveButton && (
          <div className="flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : (submitLabel ?? 'Save details')}
            </Button>
          </div>
        )}
      </form>
    );
  },
);

interface FieldTextProps {
  id: string;
  label: string;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  register: ReturnType<UseFormRegister<HeaderFormValues>>;
  error?: string;
  note?: ReactNode;
}

function FieldText({
  id,
  label,
  type = 'text',
  placeholder,
  autoFocus,
  disabled,
  register,
  error,
  note,
}: FieldTextProps): React.ReactElement {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        {...register}
      />
      {note && <div id={`${id}-note`}>{note}</div>}
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
  step?: string;
  inputMode?: 'numeric' | 'decimal';
  required?: boolean;
  disabled?: boolean;
  register: ReturnType<UseFormRegister<HeaderFormValues>>;
  error?: string;
  note?: ReactNode;
}

function FieldNumber({
  id,
  label,
  min,
  step,
  inputMode,
  required,
  disabled,
  register,
  error,
  note,
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
        step={step}
        inputMode={inputMode}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        {...register}
      />
      {note && <div id={`${id}-note`}>{note}</div>}
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
