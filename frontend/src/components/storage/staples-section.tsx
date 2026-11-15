import type {
  StapleState,
  StorageLocation,
  StorageStaple,
} from '@loftys-larder/shared';
import { useId, useState } from 'react';

import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { LOCATION_LABELS } from '@/components/storage/location-tabs.tsx';
import { StapleStateToggle } from '@/components/storage/staple-state-toggle.tsx';
import type { StapleMarking } from '@/hooks/use-staple-marking.ts';
import { trpc } from '@/lib/trpc.ts';

interface StapleOption extends SearchableComboboxOption {
  stapleLocation: StorageLocation | null;
}

// A location's Staples (DEC-118), each with its one-tap state. Picking an
// ingredient makes it a Staple here, or moves it here from another location.
export function StaplesSection({
  location,
  staples,
  marking,
}: {
  location: StorageLocation;
  staples: StorageStaple[];
  marking: StapleMarking;
}): React.ReactElement {
  const fieldId = useId();
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const setState = trpc.ingredients.setStapleState.useMutation({
    onSettled: async () => {
      setSavingId(null);
      await Promise.all([
        utils.storage.list.invalidate(),
        utils.shopping.getForPlan.invalidate(),
      ]);
    },
  });
  const here = staples.filter((staple) => staple.location === location);
  const label = LOCATION_LABELS[location];

  async function search(query: string): Promise<readonly StapleOption[]> {
    const trimmed = query.trim();
    const rows = await utils.ingredients.list.fetch(
      trimmed ? { search: trimmed } : undefined,
    );
    return rows
      .filter((row) => row.stapleLocation !== location)
      .map((row) => ({
        id: row.id,
        label: row.name,
        stapleLocation: row.stapleLocation,
      }));
  }

  function change(staple: StorageStaple, state: StapleState): void {
    setError(null);
    setSavingId(staple.ingredientId);
    setState.mutate(
      { id: staple.ingredientId, state },
      {
        onError: () => {
          setError(`Couldn’t update ${staple.name}. Try again.`);
        },
      },
    );
  }

  async function mark(option: StapleOption | null): Promise<void> {
    if (!option) return;
    setError(null);
    try {
      await marking.save(
        { id: option.id, patch: { stapleLocation: location } },
        option.label,
        () => undefined,
      );
    } catch {
      setError(`Couldn’t make ${option.label} a Staple. Try again.`);
    }
  }

  return (
    <section aria-labelledby={`${fieldId}-title`} className="space-y-2">
      <h2
        id={`${fieldId}-title`}
        className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Staples
      </h2>
      {here.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Staples in the {label.toLowerCase()}. Add the basics you always
          keep here.
        </p>
      ) : (
        <ul className="divide-y">
          {here.map((staple) => (
            <li
              key={staple.ingredientId}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="min-w-0 truncate text-sm font-medium">
                {staple.name}
              </span>
              <StapleStateToggle
                name={staple.name}
                state={staple.state}
                disabled={savingId === staple.ingredientId}
                onChange={(state) => {
                  change(staple, state);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-1">
        <label htmlFor={`${fieldId}-add`} className="text-sm font-medium">
          Add a Staple to the {label.toLowerCase()}
        </label>
        <SearchableCombobox<StapleOption>
          key={here.length}
          id={`${fieldId}-add`}
          value={null}
          onChange={(option) => {
            void mark(option);
          }}
          searchQuery={search}
          placeholder="Search ingredients"
          disabled={marking.isPending}
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
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
