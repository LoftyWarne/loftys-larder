import type { RecipeMethodStep } from '@loftys-larder/shared';
import { ChevronDown } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.tsx';
import { cn } from '@/lib/utils.ts';

interface StepListDialogProps {
  label: string;
  method: readonly RecipeMethodStep[];
  current: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (step: number) => void;
}

export const GATHER_LABEL = 'Gather ingredients';

// "Step N of M" in cook mode opens every screen to jump to (DEC-116). Screen 0
// is the gather screen; screen N is method step N.
export function StepListDialog({
  label,
  method,
  current,
  open,
  onOpenChange,
  onChoose,
}: StepListDialogProps): React.ReactElement {
  const screens = [
    GATHER_LABEL,
    ...method.map((step, index) => `${String(index + 1)}. ${step.instruction}`),
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger className="inline-flex items-center gap-1 rounded-md text-2xl font-semibold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {label}
        <ChevronDown aria-hidden className="size-5" />
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85dvh] overflow-y-auto"
      >
        <DialogTitle>Steps</DialogTitle>
        <ol className="space-y-1">
          {screens.map((text, index) => (
            <li key={index}>
              <button
                type="button"
                aria-current={index === current ? 'step' : undefined}
                onClick={() => {
                  onChoose(index);
                }}
                className={cn(
                  'w-full truncate rounded-md px-3 py-3 text-left text-base hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  index === current && 'bg-accent font-semibold',
                )}
              >
                {text}
              </button>
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
