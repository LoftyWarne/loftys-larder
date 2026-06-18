import {
  duplicatePlanInputSchema,
  type DuplicatePlanInput,
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
import { Input } from '@/components/ui/input.tsx';

export interface DuplicatePlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: { id: number; startDate: string; endDate: string } | null;
  onSubmit: (values: DuplicatePlanInput) => Promise<void>;
  serverError?: string | null;
  defaultNewStartDate: string;
  isSubmitting?: boolean;
}

export function DuplicatePlanDialog({
  open,
  onOpenChange,
  source,
  onSubmit,
  serverError,
  defaultNewStartDate,
  isSubmitting,
}: DuplicatePlanDialogProps): React.ReactElement | null {
  const form = useForm<DuplicatePlanInput>({
    resolver: zodResolver(duplicatePlanInputSchema),
    defaultValues: {
      planId: source?.id ?? 0,
      newStartDate: defaultNewStartDate,
    },
  });

  // Re-seed the form whenever the dialog opens for a (possibly different)
  // source plan, so `planId` and the suggested start date stay in sync.
  useEffect(() => {
    if (open && source) {
      form.reset({ planId: source.id, newStartDate: defaultNewStartDate });
    }
  }, [open, source, defaultNewStartDate, form]);

  if (!source) return null;

  const submitting = isSubmitting ?? form.formState.isSubmitting;

  const submit = form.handleSubmit(async (values) => {
    await onSubmit(values);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate plan</DialogTitle>
          <DialogDescription>
            Copy {source.startDate} – {source.endDate} to a new start date. The
            new plan keeps the same duration; slot assignments are shifted to
            match.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-1">
            <label
              htmlFor="duplicate-plan-start"
              className="text-sm font-medium"
            >
              New start date
            </label>
            <Input
              id="duplicate-plan-start"
              type="date"
              disabled={submitting}
              aria-invalid={
                form.formState.errors.newStartDate ? true : undefined
              }
              {...form.register('newStartDate')}
            />
            {form.formState.errors.newStartDate && (
              <p role="alert" className="text-sm text-destructive">
                {form.formState.errors.newStartDate.message}
              </p>
            )}
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
              {submitting ? 'Duplicating…' : 'Duplicate'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
