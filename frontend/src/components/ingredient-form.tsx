import {
  createIngredientInputSchema,
  type CreateIngredientInput,
  type IngredientReferences,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';

export type IngredientFormValues = CreateIngredientInput;

export interface IngredientFormProps {
  references: IngredientReferences;
  defaultValues: IngredientFormValues;
  onSubmit: (values: IngredientFormValues) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
  nameError?: string;
}

const SHELF_LIFE_PLACEHOLDER = 'e.g. 7';

export function IngredientForm({
  references,
  defaultValues,
  onSubmit,
  onCancel,
  submitLabel,
  nameError,
}: IngredientFormProps): React.ReactElement {
  const form = useForm<IngredientFormValues>({
    resolver: zodResolver(createIngredientInputSchema),
    defaultValues,
  });

  useEffect(() => {
    if (nameError) {
      form.setError('name', { type: 'server', message: nameError });
    }
  }, [nameError, form]);

  const submitting = form.formState.isSubmitting;

  const submit = form.handleSubmit(async (values) => {
    form.clearErrors('name');
    await onSubmit(values);
  });

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="space-y-4"
      noValidate
    >
      <div className="space-y-1">
        <label htmlFor="ingredient-name" className="text-sm font-medium">
          Name
        </label>
        <Input
          id="ingredient-name"
          type="text"
          autoComplete="off"
          autoFocus
          disabled={submitting}
          aria-invalid={form.formState.errors.name ? true : undefined}
          {...form.register('name')}
        />
        {form.formState.errors.name && (
          <p role="alert" className="text-sm text-destructive">
            {form.formState.errors.name.message}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label htmlFor="ingredient-category" className="text-sm font-medium">
            Category
          </label>
          <select
            id="ingredient-category"
            disabled={submitting}
            aria-invalid={form.formState.errors.categoryId ? true : undefined}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            {...form.register('categoryId', { valueAsNumber: true })}
          >
            {references.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="ingredient-unit" className="text-sm font-medium">
            Default unit
          </label>
          <select
            id="ingredient-unit"
            disabled={submitting}
            aria-invalid={
              form.formState.errors.defaultUnitId ? true : undefined
            }
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            {...form.register('defaultUnitId', { valueAsNumber: true })}
          >
            {references.units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="ingredient-shelf-life" className="text-sm font-medium">
          Average shelf life (days)
        </label>
        <Input
          id="ingredient-shelf-life"
          type="number"
          min={1}
          max={3650}
          placeholder={SHELF_LIFE_PLACEHOLDER}
          disabled={submitting}
          aria-invalid={
            form.formState.errors.averageShelfLifeDays ? true : undefined
          }
          {...form.register('averageShelfLifeDays', {
            setValueAs: (value) =>
              value === '' || value === null ? null : Number(value),
          })}
        />
        {form.formState.errors.averageShelfLifeDays && (
          <p role="alert" className="text-sm text-destructive">
            {form.formState.errors.averageShelfLifeDays.message}
          </p>
        )}
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          disabled={submitting}
          {...form.register('isPlant')}
        />
        <span>Counts towards plant points</span>
      </label>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
