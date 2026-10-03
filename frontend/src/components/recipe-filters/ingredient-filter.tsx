import { RECIPE_FILTER_INGREDIENTS_MAX } from '@loftys-larder/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  SearchableCombobox,
  type SearchableComboboxHandle,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import {
  type RecipeFilterOption,
  selectionSummary,
} from '@/lib/recipe-filters.ts';

import { FilterPopover } from './filter-popover.tsx';

// Only ingredients on a recipe are offered (`recipes.listIngredients`), so the
// list is small enough to search in the browser.
export interface IngredientFilterProps {
  options: readonly RecipeFilterOption[];
  selectedIds: readonly number[];
  onChange: (next: number[]) => void;
}

export function IngredientFilter({
  options,
  selectedIds,
  onChange,
}: IngredientFilterProps): React.ReactElement | null {
  // Remounting the combobox after each pick clears its text; the new one
  // takes focus so several ingredients can be picked in a row.
  const [pickerKey, setPickerKey] = useState(0);
  const pickerRef = useRef<SearchableComboboxHandle>(null);
  useEffect(() => {
    if (pickerKey > 0) pickerRef.current?.focus();
  }, [pickerKey]);

  const searchQuery = useCallback(
    (query: string): SearchableComboboxOption[] => {
      const lowered = query.toLowerCase();
      const chosen = new Set(selectedIds);
      return options
        .filter(
          (option) =>
            !chosen.has(option.id) &&
            option.name.toLowerCase().includes(lowered),
        )
        .map((option) => ({ id: option.id, label: option.name }));
    },
    [options, selectedIds],
  );

  if (options.length === 0 && selectedIds.length === 0) return null;

  const names = new Map(options.map((option) => [option.id, option.name]));
  const atLimit = selectedIds.length >= RECIPE_FILTER_INGREDIENTS_MAX;
  return (
    <FilterPopover
      label="Ingredients"
      summary={selectionSummary(selectedIds, options)}
      onClear={() => {
        onChange([]);
      }}
    >
      <SearchableCombobox
        key={pickerKey}
        ref={pickerRef}
        value={null}
        onChange={(option) => {
          if (!option) return;
          onChange([...selectedIds, option.id]);
          setPickerKey((key) => key + 1);
        }}
        searchQuery={searchQuery}
        ariaLabel="Find an ingredient"
        placeholder={
          atLimit
            ? `Up to ${String(RECIPE_FILTER_INGREDIENTS_MAX)} ingredients`
            : 'Find an ingredient'
        }
        disabled={atLimit}
        emptyMessage="No matching ingredients"
      />
      {selectedIds.length > 0 && (
        <ul
          aria-label="Selected ingredients"
          className="flex flex-wrap gap-1.5"
        >
          {selectedIds.map((id) => {
            const name = names.get(id) ?? 'Unknown ingredient';
            return (
              <li
                key={id}
                className="flex items-center gap-1 rounded-full border border-input px-2.5 py-0.5 text-xs"
              >
                {name}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    onChange(selectedIds.filter((other) => other !== id));
                  }}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </FilterPopover>
  );
}
