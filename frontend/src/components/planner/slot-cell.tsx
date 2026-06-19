import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { PlanSlot } from '@loftys-larder/shared';
import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils.ts';

// Reusable slot card with explicit named regions for future FEATs
// (cross-cutting #14). FEAT-31 renders the base body — recipe name / icon /
// servings; FEAT-32 fills `baseCookLine`, FEAT-33 fills `chefChip`. Extending
// the shape later means adding props, not rewriting.
//
// FEAT-40 adds optional DnD wiring: when `dndEnabled` is true the cell
// registers as a droppable (always) and a draggable (when populated).
// Click semantics are untouched — the pointer sensor's activation distance
// keeps taps as taps.
export interface SlotCellProps {
  slot: PlanSlot;
  onClick: () => void;
  onClear?: () => void;
  isSelected?: boolean;
  dndEnabled?: boolean;
  // Future content regions — leave open for downstream FEATs.
  baseCookLine?: ReactNode;
  chefChip?: ReactNode;
  commentLine?: ReactNode;
}

const STATE_LABEL: Record<Exclude<PlanSlot['slotType'], 'recipe'>, string> = {
  empty: 'Empty',
  eat_out: 'Eat out',
  takeaway: 'Takeaway',
  leftovers: 'Leftovers',
};

export function SlotCell({
  slot,
  onClick,
  onClear,
  isSelected = false,
  dndEnabled = false,
  baseCookLine,
  chefChip,
  commentLine,
}: SlotCellProps): React.ReactElement {
  const showClear = onClear !== undefined && slot.slotType !== 'empty';
  // Hooks are unconditional so a tier flip on rotation doesn't violate the
  // rules-of-hooks; `disabled` is the real gate.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `slot-drop:${String(slot.id)}`,
    data: { kind: 'slot', slot },
    disabled: !dndEnabled,
  });
  const {
    setNodeRef: setDragRef,
    attributes,
    listeners,
    isDragging,
  } = useDraggable({
    id: `slot-drag:${String(slot.id)}`,
    data: { kind: 'slot', slot },
    disabled: !dndEnabled || slot.slotType === 'empty',
  });
  return (
    <div ref={setDropRef} className="relative h-full">
      <button
        type="button"
        ref={setDragRef}
        onClick={onClick}
        aria-label={describeSlotForA11y(slot)}
        data-slot-id={slot.id}
        data-slot-type={slot.slotType}
        {...attributes}
        {...listeners}
        className={cn(
          'flex h-full min-h-20 w-full flex-col items-stretch gap-1 rounded-md border border-input bg-card p-2 text-left text-sm transition hover:border-primary focus:outline-none focus:ring-2 focus:ring-ring',
          showClear && 'pr-8',
          slot.slotType === 'empty' &&
            'border-dashed text-muted-foreground italic',
          isSelected && 'border-primary ring-2 ring-ring',
          dndEnabled && slot.slotType !== 'empty' && 'cursor-grab',
          isOver && 'border-primary ring-2 ring-primary',
          isDragging && 'opacity-40',
        )}
      >
        <SlotBody slot={slot} />
        {baseCookLine}
        {chefChip}
        {commentLine}
      </button>
      {showClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Clear ${describeSlotForA11y(slot)}`}
          className="absolute top-1 right-1 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function SlotBody({ slot }: { slot: PlanSlot }): React.ReactElement {
  if (slot.slotType === 'recipe' && slot.recipe) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="font-medium leading-tight">
          {slot.recipe.name}
          {slot.recipe.isDeleted && (
            <span className="ml-1 text-xs text-muted-foreground">
              (deleted)
            </span>
          )}
        </span>
        {slot.numberOfServings !== null && (
          <span className="text-xs text-muted-foreground">
            {String(slot.numberOfServings)} servings
          </span>
        )}
      </div>
    );
  }
  if (slot.slotType === 'recipe') {
    // Defensive: recipe state without a loaded recipe row (concurrent
    // soft-delete + cache lag). Render the id so the user can still target
    // the slot.
    return <span>Recipe #{String(slot.recipeId)}</span>;
  }
  return <span>{STATE_LABEL[slot.slotType]}</span>;
}

function describeSlotForA11y(slot: PlanSlot): string {
  const base = `${slot.occasionName} on ${slot.date}`;
  if (slot.slotType === 'recipe') {
    return slot.recipe
      ? `${base}: ${slot.recipe.name}`
      : `${base}: recipe #${String(slot.recipeId ?? '')}`;
  }
  if (slot.slotType === 'empty') {
    return `${base}: empty slot`;
  }
  return `${base}: ${STATE_LABEL[slot.slotType]}`;
}
