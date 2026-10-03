import { useId } from 'react';

import { RECIPE_TIME_LIMITS } from '@/lib/recipe-filters.ts';

import { FilterPopover } from './filter-popover.tsx';

export interface TimeFilterProps {
  label: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}

export function TimeFilter({
  label,
  value,
  onChange,
}: TimeFilterProps): React.ReactElement {
  const name = useId();
  const choices = [undefined, ...RECIPE_TIME_LIMITS];
  return (
    <FilterPopover
      label={label}
      summary={value === undefined ? null : `up to ${String(value)} min`}
      onClear={() => {
        onChange(undefined);
      }}
    >
      <fieldset className="flex flex-col gap-0.5">
        <legend className="sr-only">{label}</legend>
        {choices.map((limit) => (
          <label
            key={limit ?? 'any'}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-accent"
          >
            <input
              type="radio"
              name={name}
              checked={value === limit}
              onChange={() => {
                onChange(limit);
              }}
              className="h-4 w-4 accent-primary"
            />
            {limit === undefined ? 'Any' : `Up to ${String(limit)} min`}
          </label>
        ))}
      </fieldset>
    </FilterPopover>
  );
}
