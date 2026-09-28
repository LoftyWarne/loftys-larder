import { Lightbulb, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils.ts';

export type StepNoteKind = 'safety' | 'tip';

const KIND_STYLES = {
  safety: {
    label: 'Safety',
    Icon: TriangleAlert,
    className: 'border-amber-400 bg-amber-50 text-amber-900',
  },
  tip: {
    label: 'Tip',
    Icon: Lightbulb,
    className: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  },
} as const;

interface StepNoteCalloutProps {
  kind: StepNoteKind;
  children: React.ReactNode;
  // Rendered at the end of the label row, e.g. the editor's remove button.
  action?: React.ReactNode;
}

export function StepNoteCallout({
  kind,
  children,
  action,
}: StepNoteCalloutProps): React.ReactElement {
  const { label, Icon, className } = KIND_STYLES[kind];
  return (
    <div
      role="note"
      aria-label={label}
      className={cn(
        'flex gap-2 rounded-md border px-3 py-2 text-sm',
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium">{label}</p>
          {action}
        </div>
        {children}
      </div>
    </div>
  );
}
