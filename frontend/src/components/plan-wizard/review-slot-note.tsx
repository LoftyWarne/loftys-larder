import { Sparkles } from 'lucide-react';

import type { ReviewPlanSlot } from '@/lib/plan-wizard.ts';

// What Plan Review says under a slot's dishes, in the slot card's comment
// region: the AI badge and reason on a suggestion (DEC-110 rule 2), or how
// the cook left the slot.
export function ReviewSlotNote({
  kind,
  reason,
}: Pick<ReviewPlanSlot, 'kind' | 'reason'>): React.ReactElement | null {
  switch (kind) {
    case 'suggested':
      return (
        <div className="flex flex-col gap-1 not-italic">
          <span className="inline-flex w-fit items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            AI suggestion
          </span>
          {reason && (
            <span className="text-xs break-words text-muted-foreground">
              {reason}
            </span>
          )}
        </div>
      );
    case 'fixed':
      return <ReviewTag>Fixed</ReviewTag>;
    case 'swapped':
      return <ReviewTag>Your pick</ReviewTag>;
    case 'discarded':
      return <ReviewTag>Discarded</ReviewTag>;
    case 'unfilled':
      return null;
  }
}

function ReviewTag({ children }: { children: string }): React.ReactElement {
  return (
    <span className="inline-flex w-fit rounded-full border border-input px-2 py-0.5 text-xs font-medium text-muted-foreground not-italic">
      {children}
    </span>
  );
}
