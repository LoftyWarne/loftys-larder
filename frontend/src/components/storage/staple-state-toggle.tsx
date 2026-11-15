import type { StapleState } from '@loftys-larder/shared';

import { cn } from '@/lib/utils.ts';

export const STAPLE_STATE_LABELS: Record<StapleState, string> = {
  in_stock: 'In stock',
  running_low: 'Running low',
  out: 'Out',
};

const ORDER: StapleState[] = ['in_stock', 'running_low', 'out'];

// One tap sets a Staple's state (DEC-118).
export function StapleStateToggle({
  name,
  state,
  disabled,
  onChange,
}: {
  name: string;
  state: StapleState;
  disabled?: boolean;
  onChange: (state: StapleState) => void;
}): React.ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label={`${name}: how much you have`}
      className="inline-flex shrink-0 rounded-md border"
    >
      {ORDER.map((value) => {
        const checked = value === state;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => {
              if (!checked) onChange(value);
            }}
            className={cn(
              'px-2 py-1 text-xs font-medium first:rounded-l-md last:rounded-r-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
              checked
                ? value === 'in_stock'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-destructive text-destructive-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {STAPLE_STATE_LABELS[value]}
          </button>
        );
      })}
    </div>
  );
}
