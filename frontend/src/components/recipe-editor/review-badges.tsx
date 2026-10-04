import {
  ESTIMATE_LABELS,
  type EstimateKind,
} from '@/lib/recipe-import-estimates.ts';
import { cn } from '@/lib/utils.ts';

// Badges Import Review puts beside the editor's controls: an Estimate mark
// on a value the import input didn't state (DEC-106), and "New" on an
// ingredient or source that will be created with the recipe (DEC-105).

interface EstimateMarkProps {
  kind: EstimateKind;
  id?: string;
  className?: string;
}

export function EstimateMark({
  kind,
  id,
  className,
}: EstimateMarkProps): React.ReactElement {
  return (
    <span
      id={id}
      className={cn(
        'inline-flex w-fit items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900',
        className,
      )}
    >
      {ESTIMATE_LABELS[kind]}
    </span>
  );
}

export function NewBadge(): React.ReactElement {
  return (
    <span className="shrink-0 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-900">
      New
    </span>
  );
}
