import {
  createPlanInputSchema,
  type CreatePlanInput,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { WizardStep } from '@/components/plan-wizard/wizard-step.tsx';
import { DateInput } from '@/components/ui/date-input.tsx';

export interface DatesStepProps {
  defaultValues: CreatePlanInput;
  // Runs plan creation's date checks; resolves with an error message to show,
  // or null to move on.
  onSubmit: (values: CreatePlanInput) => Promise<string | null>;
}

const FORM_ID = 'plan-wizard-dates';

export function DatesStep({
  defaultValues,
  onSubmit,
}: DatesStepProps): React.ReactElement {
  const form = useForm<CreatePlanInput>({
    resolver: zodResolver(createPlanInputSchema),
    defaultValues,
  });
  const submitting = form.formState.isSubmitting;
  const serverError = form.formState.errors.root?.message;

  const submit = form.handleSubmit(async (values) => {
    const error = await onSubmit(values);
    if (error) form.setError('root', { message: error });
  });

  return (
    <WizardStep
      step={1}
      title="Which dates?"
      description="Up to 14 days, not overlapping a current or future plan."
      formId={FORM_ID}
      nextLabel={submitting ? 'Checking…' : 'Next'}
      nextDisabled={submitting}
    >
      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        <div className="space-y-1">
          <label htmlFor="plan-wizard-start" className="text-sm font-medium">
            Start date
          </label>
          <DateInput
            id="plan-wizard-start"
            disabled={submitting}
            aria-invalid={form.formState.errors.startDate ? true : undefined}
            {...form.register('startDate')}
          />
          {form.formState.errors.startDate && (
            <p role="alert" className="text-sm text-destructive">
              {form.formState.errors.startDate.message}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label htmlFor="plan-wizard-end" className="text-sm font-medium">
            End date
          </label>
          <DateInput
            id="plan-wizard-end"
            disabled={submitting}
            aria-invalid={form.formState.errors.endDate ? true : undefined}
            {...form.register('endDate')}
          />
          {form.formState.errors.endDate && (
            <p role="alert" className="text-sm text-destructive">
              {form.formState.errors.endDate.message}
            </p>
          )}
        </div>
        {serverError && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {serverError}
          </p>
        )}
      </form>
    </WizardStep>
  );
}
