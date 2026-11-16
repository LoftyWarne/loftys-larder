import {
  defaultUseBy,
  stockItemAddFormSchema,
  STORAGE_LOCATIONS,
  type CreateIngredientInput,
  type StockItemAddForm,
  type StorageLocation,
  type UseByTarget,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';

import { IngredientForm } from '@/components/ingredient-form.tsx';
import { RecipeTypeBadge } from '@/components/planner/recipe-type-badge.tsx';
import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { LOCATION_LABELS } from '@/components/storage/location-tabs.tsx';
import { SELECT_CLASS } from '@/components/storage/select-class.ts';
import { StapleAddForm } from '@/components/storage/staple-add-form.tsx';
import { Button } from '@/components/ui/button.tsx';
import { DateInput } from '@/components/ui/date-input.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { StapleMarking } from '@/hooks/use-staple-marking.ts';
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import { trpc } from '@/lib/trpc.ts';

type Kind = 'ingredient' | 'recipe' | 'staple';

const KIND_LABELS: Record<Kind, string> = {
  ingredient: 'Ingredient',
  recipe: 'Dish',
  staple: 'Staple',
};

interface PickOption extends SearchableComboboxOption {
  kind: Exclude<Kind, 'staple'>;
  unitName: string | null;
  averageShelfLifeDays: number | null;
  isBase: boolean;
  baseRecipeId: number | null;
  stapleLocation: StorageLocation | null;
}

function shelfLifeTargetOf(option: PickOption): UseByTarget {
  return option.kind === 'recipe'
    ? { kind: 'recipe' }
    : { kind: 'ingredient', averageShelfLifeDays: option.averageShelfLifeDays };
}

interface StockAddSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: StorageLocation;
  today: string;
  marking: StapleMarking;
}

// Adds a Stock item: always an existing ingredient or recipe, never free text
// (DEC-118). An ingredient can be created inline. Also makes a Staple.
export function StockAddSheet({
  open,
  onOpenChange,
  location,
  today,
  marking,
}: StockAddSheetProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && (
          <AddForm
            location={location}
            today={today}
            marking={marking}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddForm({
  location,
  today,
  marking,
  onDone,
}: {
  location: StorageLocation;
  today: string;
  marking: StapleMarking;
  onDone: () => void;
}): React.ReactElement {
  const fieldId = useId();
  const utils = trpc.useUtils();
  const createMutation = trpc.storage.create.useMutation();
  const createIngredientMutation = trpc.ingredients.create.useMutation();
  const [kind, setKind] = useState<Kind>('ingredient');
  const [picked, setPicked] = useState<PickOption | null>(null);
  const [useByTouched, setUseByTouched] = useState(false);
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [createNameError, setCreateNameError] = useState<string>();
  const [submitError, setSubmitError] = useState<string | null>(null);
  // A Staple is never a Stock item (DEC-118). Picking one says where its
  // state is kept instead.
  const [staplePicked, setStaplePicked] = useState<PickOption | null>(null);
  const referencesQuery = trpc.ingredients.references.useQuery(undefined, {
    enabled: creatingName !== null,
  });

  const form = useForm<StockItemAddForm>({
    resolver: zodResolver(stockItemAddFormSchema),
    defaultValues: {
      location,
      target: null,
      quantity: '',
      addedOn: today,
      useBy: '',
    },
  });
  const currentLocation = form.watch('location');
  const errors = form.formState.errors;

  function refreshUseBy(next: {
    option?: PickOption | null;
    addedOn?: string;
    location?: StorageLocation;
  }): void {
    if (useByTouched) return;
    const option = next.option === undefined ? picked : next.option;
    const where = next.location ?? form.getValues('location');
    const addedOn = next.addedOn ?? form.getValues('addedOn');
    if (where !== 'fridge' || !option || !/^\d{4}-\d{2}-\d{2}$/.test(addedOn)) {
      form.setValue('useBy', '');
      return;
    }
    form.setValue(
      'useBy',
      defaultUseBy(addedOn, shelfLifeTargetOf(option)) ?? '',
    );
  }

  function pick(option: PickOption | null): void {
    if (option?.stapleLocation != null) {
      setStaplePicked(option);
      option = null;
    } else {
      setStaplePicked(null);
    }
    setPicked(option);
    form.setValue(
      'target',
      option === null
        ? null
        : option.kind === 'ingredient'
          ? { kind: 'ingredient', ingredientId: option.id }
          : { kind: 'recipe', recipeId: option.id },
      { shouldValidate: form.formState.isSubmitted },
    );
    refreshUseBy({ option });
  }

  async function search(query: string): Promise<readonly PickOption[]> {
    const trimmed = query.trim();
    if (kind === 'ingredient') {
      const rows = await utils.ingredients.list.fetch(
        trimmed ? { search: trimmed } : undefined,
      );
      return rows.map((row) => ({
        id: row.id,
        label: row.name,
        kind: 'ingredient',
        unitName: row.defaultUnitName,
        averageShelfLifeDays: row.averageShelfLifeDays,
        isBase: false,
        baseRecipeId: null,
        stapleLocation: row.stapleLocation,
      }));
    }
    const result = await utils.recipes.list.fetch({
      search: trimmed || undefined,
      includePickerHidden: true,
      limit: 20,
    });
    return result.items.map((recipe) => ({
      id: recipe.id,
      label: recipe.name,
      kind: 'recipe',
      unitName: null,
      averageShelfLifeDays: null,
      isBase: recipe.isBase,
      baseRecipeId: recipe.baseRecipeId,
      stapleLocation: null,
    }));
  }

  async function handleCreateIngredient(
    values: CreateIngredientInput,
  ): Promise<void> {
    setCreateNameError(undefined);
    try {
      const created = await createIngredientMutation.mutateAsync(values);
      await utils.ingredients.list.invalidate();
      pick({
        id: created.id,
        label: created.name,
        kind: 'ingredient',
        unitName: created.defaultUnitName,
        averageShelfLifeDays: created.averageShelfLifeDays,
        isBase: false,
        baseRecipeId: null,
        stapleLocation: null,
      });
      setCreatingName(null);
    } catch (error) {
      if (getDomainErrorCode(error) === 'INGREDIENT_NAME_TAKEN') {
        setCreateNameError('An ingredient with this name already exists');
        return;
      }
      throw error;
    }
  }

  const submit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    if (!values.target) return;
    try {
      await createMutation.mutateAsync({
        location: values.location,
        target: values.target,
        quantity: values.quantity,
        addedOn: values.addedOn,
        ...(values.location === 'fridge' && {
          useBy: values.useBy === '' ? null : values.useBy,
        }),
      });
      await utils.storage.list.invalidate();
      onDone();
    } catch (error) {
      const code = getDomainErrorCode(error);
      setSubmitError(
        code === 'STOCK_ADDED_ON_FUTURE'
          ? 'The date added can’t be after today.'
          : code === 'STOCK_TARGET_NOT_FOUND'
            ? 'That ingredient or dish is no longer available.'
            : 'Couldn’t add that. Try again.',
      );
    }
  });

  if (creatingName !== null) {
    const references = referencesQuery.data;
    return (
      <>
        <DialogHeader>
          <DialogTitle>New ingredient</DialogTitle>
          <DialogDescription>
            Adds a new ingredient to your household, then picks it here.
          </DialogDescription>
        </DialogHeader>
        {references ? (
          <IngredientForm
            references={references}
            defaultValues={{
              name: creatingName,
              categoryId: references.categories[0]?.id ?? 0,
              defaultUnitId: references.units[0]?.id ?? 0,
              isPlant: false,
              averageShelfLifeDays: null,
            }}
            submitLabel="Create ingredient"
            nameError={createNameError}
            onSubmit={handleCreateIngredient}
            showStaple={false}
            onCancel={() => {
              setCreatingName(null);
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </>
    );
  }

  const kindToggle = (
    <div
      role="radiogroup"
      aria-label="What are you adding?"
      className="grid grid-cols-3 gap-2"
    >
      {(['ingredient', 'recipe', 'staple'] as const).map((value) => (
        <Button
          key={value}
          type="button"
          role="radio"
          aria-checked={kind === value}
          variant={kind === value ? 'default' : 'outline'}
          size="sm"
          onClick={() => {
            if (kind === value) return;
            setKind(value);
            pick(null);
          }}
        >
          {KIND_LABELS[value]}
        </Button>
      ))}
    </div>
  );

  if (kind === 'staple') {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Add to storage</DialogTitle>
          <DialogDescription>
            A Staple is something you always keep, tracked by whether you have
            it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {kindToggle}
          <StapleAddForm
            location={location}
            marking={marking}
            onDone={onDone}
          />
        </div>
      </>
    );
  }

  const submitting = form.formState.isSubmitting;
  const unitLabel = picked
    ? picked.kind === 'recipe'
      ? 'portions'
      : (picked.unitName ?? '')
    : '';

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add to storage</DialogTitle>
        <DialogDescription>
          Pick an ingredient or a dish you’ve cooked.
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {kindToggle}

        <div className="space-y-1">
          <label htmlFor={`${fieldId}-target`} className="text-sm font-medium">
            {kind === 'ingredient' ? 'Ingredient' : 'Dish'}
          </label>
          <SearchableCombobox<PickOption>
            key={kind}
            id={`${fieldId}-target`}
            value={picked}
            onChange={pick}
            searchQuery={search}
            placeholder={
              kind === 'ingredient' ? 'Search ingredients' : 'Search recipes'
            }
            disabled={submitting}
            {...(kind === 'ingredient' && {
              onCreate: (query: string) => {
                setCreateNameError(undefined);
                setCreatingName(query);
              },
              createLabel: (query: string) => `Create “${query}”`,
            })}
            renderOption={(option) => (
              <span className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{option.label}</span>
                {option.kind === 'recipe' ? (
                  <RecipeTypeBadge recipe={option} />
                ) : option.stapleLocation !== null ? (
                  <span className="text-xs text-muted-foreground">Staple</span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {option.unitName}
                  </span>
                )}
              </span>
            )}
          />
          {staplePicked?.stapleLocation != null && (
            <p role="alert" className="text-sm text-destructive">
              {staplePicked.label} is a Staple, tracked as in stock, running low
              or out rather than by amount. Set its state under Staples on the{' '}
              {LOCATION_LABELS[staplePicked.stapleLocation]} tab.
            </p>
          )}
          {errors.target && !staplePicked && (
            <p role="alert" className="text-sm text-destructive">
              {errors.target.message}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label
              htmlFor={`${fieldId}-quantity`}
              className="text-sm font-medium"
            >
              Amount
            </label>
            <div className="flex items-center gap-2">
              <Input
                id={`${fieldId}-quantity`}
                className="min-w-0"
                inputMode="decimal"
                autoComplete="off"
                disabled={submitting}
                aria-invalid={errors.quantity ? true : undefined}
                aria-describedby={`${fieldId}-unit`}
                {...form.register('quantity')}
              />
              <span
                id={`${fieldId}-unit`}
                className="min-w-[3ch] shrink-0 text-sm text-muted-foreground"
              >
                {unitLabel}
              </span>
            </div>
            {errors.quantity && (
              <p role="alert" className="text-sm text-destructive">
                {errors.quantity.message}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label
              htmlFor={`${fieldId}-location`}
              className="text-sm font-medium"
            >
              Where
            </label>
            <select
              id={`${fieldId}-location`}
              disabled={submitting}
              className={SELECT_CLASS}
              {...form.register('location', {
                onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                  refreshUseBy({
                    location: event.target.value as StorageLocation,
                  });
                },
              })}
            >
              {STORAGE_LOCATIONS.map((value) => (
                <option key={value} value={value}>
                  {LOCATION_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label htmlFor={`${fieldId}-added`} className="text-sm font-medium">
              {currentLocation === 'freezer' ? 'Frozen on' : 'Added on'}
            </label>
            <DateInput
              id={`${fieldId}-added`}
              max={today}
              disabled={submitting}
              aria-invalid={errors.addedOn ? true : undefined}
              {...form.register('addedOn', {
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                  refreshUseBy({ addedOn: event.target.value });
                },
              })}
            />
          </div>

          {currentLocation === 'fridge' && (
            <div className="space-y-1">
              <label
                htmlFor={`${fieldId}-use-by`}
                className="text-sm font-medium"
              >
                Use by
              </label>
              <DateInput
                id={`${fieldId}-use-by`}
                disabled={submitting}
                {...form.register('useBy', {
                  onChange: () => {
                    setUseByTouched(true);
                  },
                })}
              />
            </div>
          )}
        </div>

        {submitError && (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            Add
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
