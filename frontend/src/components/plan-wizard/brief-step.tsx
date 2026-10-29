import {
  MEAL_PLAN_BRIEF_MAX_LENGTH,
  planBriefFormSchema,
  type PlanBriefForm,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { WizardStep } from '@/components/plan-wizard/wizard-step.tsx';

export interface BriefStepProps {
  brief: string;
  nextLabel: string;
  // Offline, a step that would ask for a proposal can't go on.
  offline?: boolean;
  onBack: (brief: string) => void;
  onSubmit: (brief: string) => void;
}

const FORM_ID = 'plan-wizard-brief-form';

export function BriefStep({
  brief,
  nextLabel,
  offline = false,
  onBack,
  onSubmit,
}: BriefStepProps): React.ReactElement {
  const form = useForm<PlanBriefForm>({
    resolver: zodResolver(planBriefFormSchema),
    defaultValues: { brief },
  });
  const length = form.watch('brief').length;
  const error = form.formState.errors.brief;

  return (
    <WizardStep
      step={4}
      title="Anything to steer the plan?"
      description="Optional. Mood, effort, cuisine, health, or ingredients to use up."
      formId={FORM_ID}
      nextLabel={nextLabel}
      nextDisabled={offline}
      onBack={() => {
        onBack(form.getValues('brief'));
      }}
    >
      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            onSubmit(values.brief);
          })(event);
        }}
        className="space-y-1"
      >
        <label htmlFor="plan-wizard-brief" className="text-sm font-medium">
          Brief
        </label>
        <textarea
          id="plan-wizard-brief"
          rows={4}
          aria-invalid={error ? true : undefined}
          aria-describedby="plan-wizard-brief-count"
          placeholder="Light lunches, and use up the spinach"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...form.register('brief')}
        />
        <p
          id="plan-wizard-brief-count"
          className="text-right text-xs text-muted-foreground"
        >
          {length} / {MEAL_PLAN_BRIEF_MAX_LENGTH}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
        {offline && (
          <p className="text-sm text-muted-foreground">
            You’re offline. Planning with AI needs a connection.
          </p>
        )}
      </form>
    </WizardStep>
  );
}
