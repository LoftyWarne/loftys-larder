import { Checkbox } from '@/components/ui/checkbox.tsx';
import {
  type RecipeFilterOption,
  selectionSummary,
} from '@/lib/recipe-filters.ts';

import { FilterPopover } from './filter-popover.tsx';

// Tags and sources. Renders nothing until there's something to pick, so a
// library with no tags (or no sources) shows no empty control.
export interface ChecklistFilterProps {
  label: string;
  options: readonly RecipeFilterOption[];
  selectedIds: readonly number[];
  onChange: (next: number[]) => void;
}

export function ChecklistFilter({
  label,
  options,
  selectedIds,
  onChange,
}: ChecklistFilterProps): React.ReactElement | null {
  if (options.length === 0 && selectedIds.length === 0) return null;

  const selected = new Set(selectedIds);
  return (
    <FilterPopover
      label={label}
      summary={selectionSummary(selectedIds, options)}
      onClear={() => {
        onChange([]);
      }}
    >
      <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
        {options.map((option) => (
          <li key={option.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-accent">
              <Checkbox
                className="h-4 w-4"
                checked={selected.has(option.id)}
                onCheckedChange={(checked) => {
                  onChange(
                    checked === true
                      ? [...selectedIds, option.id]
                      : selectedIds.filter((id) => id !== option.id),
                  );
                }}
              />
              <span className="min-w-0 break-words">{option.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </FilterPopover>
  );
}
