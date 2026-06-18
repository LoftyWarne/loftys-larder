import { useEffect, useId, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx';
import { buttonVariants } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { cn } from '@/lib/utils.ts';

export interface DangerConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmationText: string;
  confirmationLabel: string;
  confirmLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  errorMessage?: string | null;
  onConfirm: () => void | Promise<void>;
}

export function DangerConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmationText,
  confirmationLabel,
  confirmLabel,
  pendingLabel,
  pending = false,
  errorMessage,
  onConfirm,
}: DangerConfirmDialogProps): React.ReactElement {
  const inputId = useId();
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const matched = typed === confirmationText;
  const disabled = pending || !matched;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {description}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <label htmlFor={inputId} className="text-sm font-medium">
            {confirmationLabel}
          </label>
          <Input
            id={inputId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
            disabled={pending}
            aria-invalid={typed.length > 0 && !matched ? true : undefined}
          />
        </div>
        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: 'destructive' }))}
            disabled={disabled}
            onClick={(event) => {
              event.preventDefault();
              if (disabled) return;
              void onConfirm();
            }}
          >
            {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
