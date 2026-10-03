import { Minus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';

interface PortionsStepperProps {
  servings: number;
  baseServings: number;
  max: number;
  // A step rather than a target number: a fast double-click fires twice
  // before `servings` re-renders, so each step must apply to the latest value.
  onStep: (delta: -1 | 1) => void;
  onReset: () => void;
}

// Picks how many portions the recipe page shows amounts for (DEC-98).
export function PortionsStepper({
  servings,
  baseServings,
  max,
  onStep,
  onReset,
}: PortionsStepperProps): React.ReactElement {
  const isAtBase = servings === baseServings;
  return (
    <div
      role="group"
      aria-label="Servings"
      className="flex items-center gap-2 text-sm"
    >
      <span className="text-muted-foreground">Servings</span>
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label="Fewer servings"
        disabled={servings <= 1}
        onClick={() => {
          onStep(-1);
        }}
      >
        <Minus aria-hidden className="size-4" />
      </Button>
      <span
        aria-live="polite"
        className="w-6 text-center font-semibold tabular-nums"
      >
        {servings}
      </span>
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label="More servings"
        disabled={servings >= max}
        onClick={() => {
          onStep(1);
        }}
      >
        <Plus aria-hidden className="size-4" />
      </Button>
      {/* Always rendered so it holds its space: if it appeared only once
          scaled, the right-aligned group would grow and slide the buttons
          left, putting Reset under a second tap on +. */}
      <button
        type="button"
        className={cn('text-primary hover:underline', isAtBase && 'invisible')}
        aria-hidden={isAtBase}
        disabled={isAtBase}
        onClick={onReset}
      >
        Reset to {baseServings}
      </button>
    </div>
  );
}
