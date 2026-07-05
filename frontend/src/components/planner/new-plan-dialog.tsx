import {
  createPlanInputSchema,
  type CreatePlanInput,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { DateInput } from '@/components/ui/date-input.tsx';

export interface NewPlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CreatePlanInput) => Promise<void>;
  serverError?: string | null;
  defaultStartDate: string;
  defaultEndDate: string;
  isSubmitting?: boolean;
}

export function NewPlanDialog({
  open,
  onOpenChange,
  onSubmit,
  serverError,
  defaultStartDate,
  defaultEndDate,
  isSubmitting,
}: NewPlanDialogProps): React.ReactElement {
  const form = useForm<CreatePlanInput>({
    resolver: zodResolver(createPlanInputSchema),
    defaultValues: { startDate: defaultStartDate, endDate: defaultEndDate },
  });

  // Reset the form whenever the dialog opens so the default range tracks
  // today (e.g. after the previous create succeeded).
  useEffect(() => {
    if (open) {
      form.reset({ startDate: defaultStartDate, endDate: defaultEndDate });
    }
  }, [open, defaultStartDate, defaultEndDate, form]);

  const submitting = isSubmitting ?? form.formState.isSubmitting;

  const submit = form.handleSubmit(async (values) => {
    await onSubmit(values);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New plan</DialogTitle>
          <DialogDescription>
            Pick a start and end date. Empty slots will be generated for every
            meal occasion in the range.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="space-y-4"
          noValidate
        >
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label htmlFor="new-plan-start" className="text-sm font-medium">
                Start date
              </label>
              <DateInput
                id="new-plan-start"
                disabled={submitting}
                aria-invalid={
                  form.formState.errors.startDate ? true : undefined
                }
                {...form.register('startDate')}
              />
              {form.formState.errors.startDate && (
                <p role="alert" className="text-sm text-destructive">
                  {form.formState.errors.startDate.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor="new-plan-end" className="text-sm font-medium">
                End date
              </label>
              <DateInput
                id="new-plan-end"
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
          </div>
          {serverError && (
            <p role="alert" className="text-sm text-destructive">
              {serverError}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create plan'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
