import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button.tsx';

// One step of the planning wizard: a heading, its fields, and Back / Next.
export interface WizardStepProps {
  step: number;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onBack?: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  // Next submits the step's form when it has one, else it calls `onNext`.
  formId?: string;
  onNext?: () => void;
}

export const WIZARD_STEP_COUNT = 4;

export function WizardStep({
  step,
  title,
  description,
  children,
  onBack,
  nextLabel,
  nextDisabled = false,
  formId,
  onNext,
}: WizardStepProps): React.ReactElement {
  return (
    <section aria-labelledby="wizard-step-title" className="space-y-4">
      <header className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">
          Step {step} of {WIZARD_STEP_COUNT}
        </p>
        <h2 id="wizard-step-title" className="text-lg font-semibold">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </header>
      {children}
      <div className="flex justify-between gap-2 border-t pt-4">
        {onBack ? (
          <Button type="button" variant="outline" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button
          type={formId ? 'submit' : 'button'}
          form={formId}
          disabled={nextDisabled}
          onClick={formId ? undefined : onNext}
        >
          {nextLabel}
        </Button>
      </div>
    </section>
  );
}
