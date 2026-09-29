import type { StepPrepAhead } from '@loftys-larder/shared';
import { AlarmClock, Clock } from 'lucide-react';

import { cn } from '@/lib/utils.ts';

export const PREP_AHEAD_STYLES = {
  required: {
    label: 'Must be done ahead',
    Icon: AlarmClock,
    className: 'border-sky-300 bg-sky-50 text-sky-900',
  },
  optional: {
    label: 'Can be done ahead',
    Icon: Clock,
    className: 'border-input bg-muted text-muted-foreground',
  },
} as const;

interface PrepAheadBadgeProps {
  prepAhead: StepPrepAhead;
  className?: string;
}

export function PrepAheadBadge({
  prepAhead,
  className,
}: PrepAheadBadgeProps): React.ReactElement {
  const {
    label,
    Icon,
    className: kindClassName,
  } = PREP_AHEAD_STYLES[prepAhead];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        kindClassName,
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {label}
    </span>
  );
}
