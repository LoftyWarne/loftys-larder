import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { PlanSlot, PlanSlotItem } from '@loftys-larder/shared';
import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { RecipeTypeBadge } from '@/components/planner/recipe-type-badge.tsx';
import { cn } from '@/lib/utils.ts';

// Reusable slot card (DEC-89). A slot's dishes — the eaten meal and any base
// cooked ahead — are one list now: tapping the card opens the slot editor where
// both are managed. FEAT-40 adds optional DnD on the card (the drag handle);
// click semantics are untouched.
export interface SlotCellProps {
  slot: PlanSlot;
  onClick: () => void;
  onClear?: () => void;
  // How many base servings this slot's meals run short by, if any.
  shortBy?: number;
  isSelected?: boolean;
  dndEnabled?: boolean;
  // Future content regions — leave open for downstream FEATs.
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
  shortBy,
  isSelected = false,
  dndEnabled = false,
  chefChip,
  commentLine,
}: SlotCellProps): React.ReactElement {
  const showClear = onClear !== undefined && slot.slotType !== 'empty';
  const isShort = shortBy !== undefined && shortBy > 0;
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
    <div
      ref={setDropRef}
      className={cn(
        'relative flex h-full min-h-20 w-full flex-col rounded-md border border-input bg-card text-sm transition hover:border-primary',
        slot.slotType === 'empty' && 'border-dashed',
        isSelected && 'border-primary ring-2 ring-ring',
        isOver && 'border-primary ring-2 ring-primary',
        isDragging && 'opacity-40',
      )}
    >
      <button
        type="button"
        ref={setDragRef}
        {...attributes}
        {...listeners}
        onClick={onClick}
        aria-label={describeSlotForA11y(slot, shortBy)}
        data-slot-id={slot.id}
        data-slot-type={slot.slotType}
        className={cn(
          'flex flex-1 flex-col items-stretch gap-1 rounded-md p-2 text-left focus:outline-none focus:ring-2 focus:ring-ring',
          dndEnabled && slot.slotType !== 'empty' && 'cursor-grab',
          showClear && 'pr-8',
          slot.slotType === 'empty' && 'text-muted-foreground italic',
        )}
      >
        <SlotBody slot={slot} />
        {isShort && (
          <span className="text-xs text-amber-700">
            ⚠ short {String(shortBy)}
          </span>
        )}
        {chefChip}
        {commentLine}
      </button>
      {showClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Clear ${describeSlotForA11y(slot, shortBy)}`}
          className="absolute top-1 right-1 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function SlotBody({ slot }: { slot: PlanSlot }): React.ReactElement {
  if (slot.items.length > 0) {
    return (
      <div className="flex flex-col gap-0.5">
        {slot.items.map((item) => (
          <span
            key={item.id}
            className="flex items-center gap-1 leading-tight"
            data-testid="slot-item-row"
          >
            <span className="min-w-0 truncate">
              {item.kind === 'cook_ahead' && '🍲 '}
              <span className="font-medium">{item.recipeName}</span>
              {item.isDeleted && (
                <span className="ml-1 text-xs text-muted-foreground">
                  (deleted)
                </span>
              )}
              <span className="ml-1 text-xs text-muted-foreground">
                ×{String(item.servings)}
              </span>
            </span>
            <RecipeTypeBadge recipe={item} className="ml-auto" />
          </span>
        ))}
      </div>
    );
  }
  if (slot.slotType === 'recipe') {
    // Defensive: a `recipe` slot with no items (concurrent edit + cache lag).
    // Render a hint so the user can still target the slot.
    return <span>Recipe</span>;
  }
  return <span>{STATE_LABEL[slot.slotType]}</span>;
}

function describeSlotForA11y(slot: PlanSlot, shortBy?: number): string {
  const short =
    shortBy !== undefined && shortBy > 0 ? `, short by ${String(shortBy)}` : '';
  const base = `${slot.occasionName} on ${slot.date}`;
  if (slot.items.length > 0) {
    const names = slot.items
      .map((item) => describeItemForA11y(item))
      .join(', ');
    return `${base}: ${names}${short}`;
  }
  if (slot.slotType === 'recipe') {
    return `${base}: recipe${short}`;
  }
  if (slot.slotType === 'empty') {
    return `${base}: empty slot`;
  }
  return `${base}: ${STATE_LABEL[slot.slotType]}${short}`;
}

function describeItemForA11y(item: PlanSlotItem): string {
  return item.kind === 'cook_ahead'
    ? `base ${item.recipeName}`
    : item.recipeName;
}
