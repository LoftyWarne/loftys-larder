import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { PlanSlot, PlanSlotItem } from '@loftys-larder/shared';
import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils.ts';

// Reusable slot card (DEC-89). The meal (the `eat` dishes) and the base cook
// (the `cook_ahead` dishes) are two independent affordances: tapping the body
// opens the Meal editor; tapping the base row opens the Base modal
// (cross-cutting #14). FEAT-40 adds optional DnD on the meal button (the drag
// handle); click semantics are untouched.
export interface SlotCellProps {
  slot: PlanSlot;
  onClick: () => void;
  onClear?: () => void;
  // Opens the Base modal for this slot. When omitted, the base affordance is
  // not rendered.
  onBaseClick?: () => void;
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

function eatItems(slot: PlanSlot): PlanSlotItem[] {
  return slot.items.filter((item) => item.kind === 'eat');
}

function cookAheadItems(slot: PlanSlot): PlanSlotItem[] {
  return slot.items.filter((item) => item.kind === 'cook_ahead');
}

export function SlotCell({
  slot,
  onClick,
  onClear,
  onBaseClick,
  shortBy,
  isSelected = false,
  dndEnabled = false,
  chefChip,
  commentLine,
}: SlotCellProps): React.ReactElement {
  const showClear = onClear !== undefined && slot.slotType !== 'empty';
  const cooks = cookAheadItems(slot);
  // Base affordance shows on every wired card — an otherwise-empty occasion can
  // be a "prep a base" day (DEC-24 decoupling).
  const showBaseAffordance = onBaseClick !== undefined;
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
        aria-label={describeSlotForA11y(slot)}
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
        {chefChip}
        {commentLine}
      </button>
      {showBaseAffordance && (
        <button
          type="button"
          onClick={onBaseClick}
          data-testid="slot-base-affordance"
          aria-label={describeBaseForA11y(cooks, shortBy)}
          className={cn(
            'flex flex-col gap-0.5 border-t border-input px-2 py-1 text-left text-xs hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
            shortBy !== undefined && shortBy > 0
              ? 'text-amber-700'
              : 'text-muted-foreground',
          )}
        >
          {cooks.length > 0 ? (
            cooks.map((item) => (
              <span key={item.id}>
                🍲 {item.recipeName}
                {item.isDeleted && ' (deleted)'} ×{String(item.servings)}
              </span>
            ))
          ) : (
            <span className={cn(!shortBy && 'text-primary')}>+ base</span>
          )}
          {shortBy !== undefined && shortBy > 0 && (
            <span>· short {String(shortBy)}</span>
          )}
        </button>
      )}
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
  const eats = eatItems(slot);
  if (slot.slotType === 'recipe' && eats.length > 0) {
    return (
      <div className="flex flex-col gap-0.5">
        {eats.map((item) => (
          <span key={item.id} className="leading-tight">
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
        ))}
      </div>
    );
  }
  if (slot.slotType === 'recipe') {
    // Defensive: a `recipe` slot with no eat items (concurrent edit + cache
    // lag). Render a hint so the user can still target the slot.
    return <span>Recipe</span>;
  }
  return <span>{STATE_LABEL[slot.slotType]}</span>;
}

function describeSlotForA11y(slot: PlanSlot): string {
  const base = `${slot.occasionName} on ${slot.date}`;
  if (slot.slotType === 'recipe') {
    const names = eatItems(slot)
      .map((item) => item.recipeName)
      .join(', ');
    return names ? `${base}: ${names}` : `${base}: recipe`;
  }
  if (slot.slotType === 'empty') {
    return `${base}: empty slot`;
  }
  return `${base}: ${STATE_LABEL[slot.slotType]}`;
}

function describeBaseForA11y(cooks: PlanSlotItem[], shortBy?: number): string {
  const short =
    shortBy !== undefined && shortBy > 0 ? `, short by ${String(shortBy)}` : '';
  if (cooks.length > 0) {
    const names = cooks
      .map((item) => `${item.recipeName} ×${String(item.servings)}`)
      .join(', ');
    return `Edit base cook: ${names}${short}`;
  }
  return `Cook a base${short}`;
}
