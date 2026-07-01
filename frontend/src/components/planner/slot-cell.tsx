import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { PlanSlot, PlanSlotItem } from '@loftys-larder/shared';
import { MessageSquare, Plus, Trash2 } from 'lucide-react';
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
  // How many base servings this slot's meals run short by, if any (slot total,
  // used for the a11y description).
  shortBy?: number;
  // Per-dish shortfall (slot-item id → servings short), so the nudge renders
  // under the dish in question.
  shortfallByItem?: ReadonlyMap<number, number>;
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
  shortfallByItem,
  isSelected = false,
  dndEnabled = false,
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
    <div
      ref={setDropRef}
      className={cn(
        'group relative flex h-full min-h-20 w-full flex-col rounded-md border border-input bg-card text-sm transition hover:border-primary',
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
          dndEnabled && slot.slotType !== 'empty'
            ? 'cursor-grab'
            : 'cursor-pointer',
          showClear && 'pr-8',
          slot.slotType === 'empty' && 'text-muted-foreground italic',
        )}
      >
        <SlotBody slot={slot} shortfallByItem={shortfallByItem} />
        {chefChip}
        {commentLine ??
          (slot.comment !== null && slot.comment !== '' && (
            <span
              data-testid="slot-comment"
              className="flex items-start gap-1 text-xs text-muted-foreground italic"
            >
              <MessageSquare
                className="mt-0.5 h-3 w-3 shrink-0"
                aria-hidden="true"
              />
              <span className="min-w-0 break-words whitespace-pre-wrap">
                {slot.comment}
              </span>
            </span>
          ))}
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

const LEFTOVERS_SOURCE_LABEL: Record<
  Exclude<NonNullable<PlanSlot['leftoversSource']>, 'plan_meal'>,
  string
> = {
  takeaway: 'Takeaway',
  other: 'Other',
};

function SlotBody({
  slot,
  shortfallByItem,
}: {
  slot: PlanSlot;
  shortfallByItem?: ReadonlyMap<number, number>;
}): React.ReactElement {
  if (slot.slotType === 'leftovers') {
    const dish = slot.items[0];
    const short = dish ? shortfallByItem?.get(dish.id) : undefined;
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">Leftovers</span>
        <span className="min-w-0 truncate font-medium">
          {dish
            ? `${dish.recipeName} ${dishQtyLabel(dish)}`
            : slot.leftoversSource !== null &&
                slot.leftoversSource !== 'plan_meal'
              ? LEFTOVERS_SOURCE_LABEL[slot.leftoversSource]
              : '—'}
        </span>
        {short !== undefined && short > 0 && <ShortfallNudge shortBy={short} />}
      </div>
    );
  }
  if (slot.items.length > 0) {
    return (
      <div className="flex flex-col gap-0.5">
        {slot.items.map((item) => {
          const short = shortfallByItem?.get(item.id);
          return (
            <div key={item.id} className="flex flex-col gap-0.5">
              <span
                className="flex items-center gap-1 leading-tight"
                data-testid="slot-item-row"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{item.recipeName}</span>
                  {item.isDeleted && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      (deleted)
                    </span>
                  )}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {dishQtyLabel(item)}
                  </span>
                </span>
                <RecipeTypeBadge recipe={item} className="ml-auto" />
              </span>
              {short !== undefined && short > 0 && (
                <ShortfallNudge shortBy={short} />
              )}
            </div>
          );
        })}
      </div>
    );
  }
  if (slot.slotType === 'recipe') {
    // Defensive: a `recipe` slot with no items (concurrent edit + cache lag).
    // Render a hint so the user can still target the slot.
    return <span>Recipe</span>;
  }
  if (slot.slotType === 'empty') {
    return (
      <span className="flex flex-1 items-center justify-center gap-1 text-muted-foreground not-italic transition group-hover:text-primary">
        <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">Add meal</span>
      </span>
    );
  }
  return <span>{STATE_LABEL[slot.slotType]}</span>;
}

// The shortfall nudge shown on the card and read out for a11y: the slot is
// planned to eat/use more of a recipe than has been cooked up to this point in
// the plan (DEC-91). Kept short but self-explanatory.
function shortfallText(shortBy: number): string {
  const unit = shortBy === 1 ? 'serving' : 'servings';
  return `Short ${String(shortBy)} ${unit} — not enough cooked yet`;
}

// Per-dish shortfall nudge, rendered under the dish it applies to.
function ShortfallNudge({ shortBy }: { shortBy: number }): React.ReactElement {
  return (
    <span className="text-xs text-amber-700" data-testid="slot-item-shortfall">
      ⚠ {shortfallText(shortBy)}
    </span>
  );
}

function describeSlotForA11y(slot: PlanSlot, shortBy?: number): string {
  const short =
    shortBy !== undefined && shortBy > 0
      ? `, ${shortfallText(shortBy).toLowerCase()}`
      : '';
  const note =
    slot.comment !== null && slot.comment !== ''
      ? `, comment: ${slot.comment}`
      : '';
  const headcount = slot.dinerUserIds.length + slot.guestCount;
  const eating = headcount > 0 ? `, ${String(headcount)} eating` : '';
  const base = `${slot.occasionName} on ${slot.date}`;
  if (slot.slotType === 'leftovers') {
    const dish = slot.items[0];
    const what = dish
      ? `${dish.recipeName} ${dishQtyLabel(dish)}`
      : slot.leftoversSource !== null && slot.leftoversSource !== 'plan_meal'
        ? LEFTOVERS_SOURCE_LABEL[slot.leftoversSource]
        : 'unset';
    return `${base}: leftovers, ${what}${short}${eating}${note}`;
  }
  if (slot.items.length > 0) {
    const names = slot.items
      .map((item) => describeItemForA11y(item))
      .join(', ');
    return `${base}: ${names}${short}${eating}${note}`;
  }
  if (slot.slotType === 'recipe') {
    return `${base}: recipe${short}${eating}${note}`;
  }
  if (slot.slotType === 'empty') {
    return `${base}: empty slot${eating}${note}`;
  }
  return `${base}: ${STATE_LABEL[slot.slotType]}${short}${eating}${note}`;
}

function describeItemForA11y(item: PlanSlotItem): string {
  // A prepared-only dish (nothing eaten here) is a batch cooked for later.
  return item.eaten <= 0 ? `prepped ${item.recipeName}` : item.recipeName;
}

// Card quantity label (DEC-91): what's eaten here, with a `+N` marker when the
// dish cooks more than it eats (surplus into the pool). A prepared-only batch
// (nothing eaten) reads as "prep ×N".
function dishQtyLabel(item: PlanSlotItem): string {
  if (item.eaten <= 0) return `prep ×${String(item.prepared)}`;
  const surplus = item.prepared - item.eaten;
  return surplus > 0
    ? `×${String(item.eaten)} +${String(surplus)}`
    : `×${String(item.eaten)}`;
}
