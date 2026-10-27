import { useState } from 'react';

import { RecipePicker } from '@/components/plan-wizard/recipe-picker.tsx';
import { ReviewSlotNote } from '@/components/plan-wizard/review-slot-note.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { formatLongDayLabel } from '@/lib/date-utils.ts';
import type { RecipeChoice, ReviewPlanSlot } from '@/lib/plan-wizard.ts';

// What Plan Review offers for one slot: swap, discard or restore. Anything
// else is done in the planner after Apply.
export interface ReviewSlotDialogProps {
  reviewSlot: ReviewPlanSlot | null;
  onClose: () => void;
  onSwap: (recipe: RecipeChoice) => void;
  onDiscard: () => void;
  onRestore: () => void;
}

export function ReviewSlotDialog({
  reviewSlot,
  onClose,
  ...actions
}: ReviewSlotDialogProps): React.ReactElement {
  return (
    <Dialog
      open={reviewSlot !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {reviewSlot && (
          <ReviewSlotActions
            key={`${reviewSlot.slot.date}|${String(reviewSlot.slot.occasionId)}`}
            reviewSlot={reviewSlot}
            {...actions}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReviewSlotActions({
  reviewSlot,
  onSwap,
  onDiscard,
  onRestore,
}: Omit<ReviewSlotDialogProps, 'reviewSlot' | 'onClose'> & {
  reviewSlot: ReviewPlanSlot;
}): React.ReactElement {
  const [swapping, setSwapping] = useState(false);
  const { slot, kind } = reviewSlot;
  const dish = slot.items[0]?.recipeName;
  const canRestore = kind === 'swapped' || kind === 'discarded';

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {slot.occasionName}, {formatLongDayLabel(slot.date)}
        </DialogTitle>
        <DialogDescription>{dish ?? 'Nothing planned here.'}</DialogDescription>
      </DialogHeader>
      <ReviewSlotNote kind={kind} reason={reviewSlot.reason} />
      {swapping && (
        <RecipePicker ariaLabel="Swap for a recipe" onPick={onSwap} />
      )}
      <DialogFooter className="flex-wrap gap-2">
        {canRestore && (
          <Button type="button" variant="outline" onClick={onRestore}>
            Restore suggestion
          </Button>
        )}
        {kind === 'suggested' && (
          <Button type="button" variant="outline" onClick={onDiscard}>
            Discard
          </Button>
        )}
        {reviewSlot.canSwap && !swapping && (
          <Button
            type="button"
            onClick={() => {
              setSwapping(true);
            }}
          >
            Swap
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
