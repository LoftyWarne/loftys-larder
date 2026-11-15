import type { ShoppingStapleLine } from '@loftys-larder/shared';

import { LOCATION_LABELS } from '@/components/storage/location-tabs.tsx';
import { STAPLE_STATE_LABELS } from '@/components/storage/staple-state-toggle.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { formatQuantity } from '@/lib/format-quantity.ts';
import { cn } from '@/lib/utils.ts';

function neededLabel(line: ShoppingStapleLine): string | null {
  if (line.neededQuantity === null) return null;
  return `${formatQuantity(line.neededQuantity, line.unit.name)} ${line.unit.name} for this plan`;
}

function StapleRestockLine({
  line,
  isQueued,
  onToggle,
}: {
  line: ShoppingStapleLine;
  isQueued: boolean;
  onToggle: (line: ShoppingStapleLine, nextChecked: boolean) => void;
}): React.ReactElement {
  const checkboxId = `shopping-staple-${String(line.ingredient.id)}`;
  const needed = neededLabel(line);
  const lowOrOut = line.state === 'running_low' || line.state === 'out';
  return (
    <li
      data-shopping-staple
      data-ingredient-id={line.ingredient.id}
      className="flex min-h-11 items-center gap-3 border-b border-border py-3 last:border-b-0"
    >
      <Checkbox
        id={checkboxId}
        checked={line.isChecked}
        onCheckedChange={(value) => {
          onToggle(line, value === true);
        }}
        aria-label={`Mark ${line.ingredient.name} as ${line.isChecked ? 'not bought' : 'bought'}`}
      />
      <label
        htmlFor={checkboxId}
        className={cn(
          'flex flex-1 cursor-pointer flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-base',
          line.isChecked && 'text-muted-foreground line-through opacity-60',
        )}
      >
        <span>
          <span className="font-medium">{line.ingredient.name}</span>
          <span className="ml-2 text-sm text-muted-foreground">
            {LOCATION_LABELS[line.location]}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2 text-sm">
          {needed && <span className="tabular-nums">{needed}</span>}
          {!line.isChecked && lowOrOut && (
            <span
              data-shopping-staple-state
              className="rounded-md bg-destructive px-1.5 py-0.5 text-xs font-medium text-destructive-foreground"
            >
              {STAPLE_STATE_LABELS[line.state]}
            </span>
          )}
          {isQueued && (
            <span
              data-print-hide
              role="status"
              aria-label="Pending sync"
              className="rounded-sm bg-muted px-1.5 py-0.5 text-xs uppercase tracking-wide text-muted-foreground"
            >
              Pending sync
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

// The Staples groups (DEC-118). Those to restock are ticked like any line,
// and a tick sets the Staple to in stock. Those the plan needs and the
// household has fold into a collapsed group with nothing to buy.
export function StaplesGroups({
  toRestock,
  youHave,
  queuedIngredientIds,
  onToggle,
}: {
  toRestock: ShoppingStapleLine[];
  youHave: ShoppingStapleLine[];
  queuedIngredientIds?: ReadonlySet<number>;
  onToggle: (line: ShoppingStapleLine, nextChecked: boolean) => void;
}): React.ReactElement | null {
  if (toRestock.length === 0 && youHave.length === 0) return null;
  return (
    <div className="space-y-6">
      {toRestock.length > 0 && (
        <section data-shopping-staples-restock className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Staples to restock
          </h2>
          <ul className="rounded-md border bg-card px-3">
            {toRestock.map((line) => (
              <StapleRestockLine
                key={line.ingredient.id}
                line={line}
                isQueued={queuedIngredientIds?.has(line.ingredient.id) ?? false}
                onToggle={onToggle}
              />
            ))}
          </ul>
        </section>
      )}
      {youHave.length > 0 && (
        <details
          data-shopping-staples-have
          className="rounded-md border bg-card px-3 py-2"
        >
          <summary className="cursor-pointer select-none py-1 text-base font-semibold">
            Staples you have ({String(youHave.length)})
          </summary>
          <ul>
            {youHave.map((line) => (
              <li
                key={line.ingredient.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-border py-2 text-sm"
              >
                <span>
                  <span className="font-medium">{line.ingredient.name}</span>
                  <span className="ml-2 text-muted-foreground">
                    {LOCATION_LABELS[line.location]}
                  </span>
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {neededLabel(line)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
