import {
  STORAGE_LOCATIONS,
  type CreateIngredientInput,
  type StorageLocation,
} from '@loftys-larder/shared';
import { useId, useState } from 'react';

import { IngredientForm } from '@/components/ingredient-form.tsx';
import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { LOCATION_LABELS } from '@/components/storage/location-tabs.tsx';
import { SELECT_CLASS } from '@/components/storage/select-class.ts';
import { Button } from '@/components/ui/button.tsx';
import { DialogFooter } from '@/components/ui/dialog.tsx';
import type { StapleMarking } from '@/hooks/use-staple-marking.ts';
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import { trpc } from '@/lib/trpc.ts';

interface StapleOption extends SearchableComboboxOption {
  stapleLocation: StorageLocation | null;
}

// Makes an ingredient a Staple in a chosen location (DEC-118): an existing one,
// moved here if it's a Staple elsewhere, or a new one created on the spot.
export function StapleAddForm({
  location,
  marking,
  onDone,
}: {
  location: StorageLocation;
  marking: StapleMarking;
  onDone: () => void;
}): React.ReactElement {
  const fieldId = useId();
  const utils = trpc.useUtils();
  const createIngredient = trpc.ingredients.create.useMutation();
  const [where, setWhere] = useState<StorageLocation>(location);
  const [picked, setPicked] = useState<StapleOption | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [createNameError, setCreateNameError] = useState<string>();
  const referencesQuery = trpc.ingredients.references.useQuery(undefined, {
    enabled: creatingName !== null,
  });

  async function search(query: string): Promise<readonly StapleOption[]> {
    const trimmed = query.trim();
    const rows = await utils.ingredients.list.fetch(
      trimmed ? { search: trimmed } : undefined,
    );
    return rows.map((row) => ({
      id: row.id,
      label: row.name,
      stapleLocation: row.stapleLocation,
    }));
  }

  async function create(values: CreateIngredientInput): Promise<void> {
    setCreateNameError(undefined);
    try {
      await createIngredient.mutateAsync({ ...values, stapleLocation: where });
    } catch (caught) {
      if (getDomainErrorCode(caught) === 'INGREDIENT_NAME_TAKEN') {
        setCreateNameError('An ingredient with this name already exists');
        return;
      }
      throw caught;
    }
    await Promise.all([
      utils.ingredients.list.invalidate(),
      utils.storage.list.invalidate(),
      utils.shopping.getForPlan.invalidate(),
    ]);
    onDone();
  }

  async function submit(): Promise<void> {
    setSubmitError(null);
    if (!picked) {
      setPickError('Pick an ingredient');
      return;
    }
    if (picked.stapleLocation === where) {
      onDone();
      return;
    }
    try {
      await marking.save(
        { id: picked.id, patch: { stapleLocation: where } },
        picked.label,
        onDone,
      );
    } catch {
      setSubmitError(`Couldn’t make ${picked.label} a Staple. Try again.`);
    }
  }

  if (creatingName !== null) {
    const references = referencesQuery.data;
    return references ? (
      <IngredientForm
        references={references}
        defaultValues={{
          name: creatingName,
          categoryId: references.categories[0]?.id ?? 0,
          defaultUnitId: references.units[0]?.id ?? 0,
          isPlant: false,
          averageShelfLifeDays: null,
        }}
        submitLabel="Create Staple"
        nameError={createNameError}
        onSubmit={create}
        showStaple={false}
        onCancel={() => {
          setCreatingName(null);
        }}
      />
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  }

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1">
        <label htmlFor={`${fieldId}-staple`} className="text-sm font-medium">
          Staple
        </label>
        <SearchableCombobox<StapleOption>
          id={`${fieldId}-staple`}
          value={picked}
          onChange={(option) => {
            setPickError(null);
            setPicked(option);
          }}
          searchQuery={search}
          placeholder="Search ingredients"
          disabled={marking.isPending}
          onCreate={(query) => {
            setCreateNameError(undefined);
            setCreatingName(query);
          }}
          createLabel={(query) => `Create “${query}”`}
          renderOption={(option) => (
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{option.label}</span>
              {option.stapleLocation !== null && (
                <span className="text-xs text-muted-foreground">
                  Staple in the {LOCATION_LABELS[option.stapleLocation]}
                </span>
              )}
            </span>
          )}
        />
        {pickError && (
          <p role="alert" className="text-sm text-destructive">
            {pickError}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor={`${fieldId}-where`} className="text-sm font-medium">
          Where
        </label>
        <select
          id={`${fieldId}-where`}
          className={SELECT_CLASS}
          value={where}
          disabled={marking.isPending}
          onChange={(event) => {
            setWhere(event.target.value as StorageLocation);
          }}
        >
          {STORAGE_LOCATIONS.map((value) => (
            <option key={value} value={value}>
              {LOCATION_LABELS[value]}
            </option>
          ))}
        </select>
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
        <Button type="submit" disabled={marking.isPending}>
          Add Staple
        </Button>
      </DialogFooter>
    </form>
  );
}
