import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { PlanSlot, RecipeListItem } from '@loftys-larder/shared';
import { type ReactNode, useState } from 'react';

// FEAT-40 — desktop / large-tablet drag-and-drop. Mounted only on the
// 'desktop' viewport tier; click-to-assign keeps working in parallel. The
// pointer sensor's 5 px activation constraint and the touch sensor's 200 ms
// hold mean a tap is still a click — see DEC-84.

export type DragKind =
  | { kind: 'recipe'; recipe: RecipeListItem }
  | { kind: 'slot'; slot: PlanSlot };

export interface DndProviderProps {
  children: ReactNode;
  onAssignRecipeToSlot: (input: {
    recipe: RecipeListItem;
    slot: PlanSlot;
  }) => void;
  onRelocateSlot: (input: { sourceSlot: PlanSlot; destSlot: PlanSlot }) => void;
}

const ANNOUNCEMENTS: Announcements = {
  onDragStart({ active }) {
    const data = active.data.current as DragKind | undefined;
    if (data?.kind === 'recipe') {
      return `Picked up recipe ${data.recipe.name}.`;
    }
    if (data?.kind === 'slot') {
      return `Picked up slot ${describeSlot(data.slot)}.`;
    }
    return `Picked up draggable item.`;
  },
  onDragOver({ active, over }) {
    if (!over) return undefined;
    const activeData = active.data.current as DragKind | undefined;
    const overData = over.data.current as DragKind | undefined;
    if (overData?.kind !== 'slot') return undefined;
    if (activeData?.kind === 'recipe') {
      return `${activeData.recipe.name} is over slot ${describeSlot(overData.slot)}.`;
    }
    if (activeData?.kind === 'slot') {
      return `Slot ${describeSlot(activeData.slot)} is over slot ${describeSlot(overData.slot)}.`;
    }
    return undefined;
  },
  onDragEnd({ active, over }) {
    if (!over) return `Dropped outside any slot.`;
    const activeData = active.data.current as DragKind | undefined;
    const overData = over.data.current as DragKind | undefined;
    if (overData?.kind !== 'slot') return `Dropped outside any slot.`;
    if (activeData?.kind === 'recipe') {
      return `Assigned ${activeData.recipe.name} to ${describeSlot(overData.slot)}.`;
    }
    if (activeData?.kind === 'slot') {
      const verb = overData.slot.slotType === 'empty' ? 'Moved' : 'Swapped';
      return `${verb} ${describeSlot(activeData.slot)} with ${describeSlot(overData.slot)}.`;
    }
    return `Drop complete.`;
  },
  onDragCancel({ active }) {
    const data = active.data.current as DragKind | undefined;
    if (data?.kind === 'recipe')
      return `Cancelled drag of ${data.recipe.name}.`;
    if (data?.kind === 'slot')
      return `Cancelled drag of slot ${describeSlot(data.slot)}.`;
    return `Cancelled drag.`;
  },
};

export function DndProvider({
  children,
  onAssignRecipeToSlot,
  onRelocateSlot,
}: DndProviderProps): React.ReactElement {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
  );

  const [active, setActive] = useState<DragKind | null>(null);

  function handleDragStart(event: DragStartEvent): void {
    const data = event.active.data.current as DragKind | undefined;
    setActive(data ?? null);
  }

  function handleDragEnd(event: DragEndEvent): void {
    setActive(null);
    if (!event.over) return;
    const activeData = event.active.data.current as DragKind | undefined;
    const overData = event.over.data.current as DragKind | undefined;
    if (!activeData || overData?.kind !== 'slot') return;
    if (activeData.kind === 'recipe') {
      if (overData.slot.slotType !== 'empty') return;
      onAssignRecipeToSlot({ recipe: activeData.recipe, slot: overData.slot });
      return;
    }
    if (activeData.slot.id === overData.slot.id) return;
    onRelocateSlot({
      sourceSlot: activeData.slot,
      destSlot: overData.slot,
    });
  }

  function handleDragCancel(): void {
    setActive(null);
  }

  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements: ANNOUNCEMENTS }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {active ? <DragPreview data={active} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function DragPreview({ data }: { data: DragKind }): React.ReactElement {
  if (data.kind === 'recipe') {
    return (
      <div className="pointer-events-none flex items-center gap-2 rounded-md border border-primary bg-card px-3 py-2 text-sm shadow-lg">
        {data.recipe.imageUrl !== null && (
          <img
            src={data.recipe.imageUrl}
            alt=""
            className="h-8 w-8 rounded object-cover"
          />
        )}
        <span className="font-medium">{data.recipe.name}</span>
      </div>
    );
  }
  return (
    <div className="pointer-events-none rounded-md border border-primary bg-card px-3 py-2 text-sm shadow-lg">
      <span className="font-medium">{describeSlot(data.slot)}</span>
    </div>
  );
}

function describeSlot(slot: PlanSlot): string {
  const eatNames = slot.items
    .filter((item) => item.eaten > 0)
    .map((item) => item.recipeName);
  if (eatNames.length > 0) return eatNames.join(', ');
  return `${slot.occasionName} on ${slot.date}`;
}
