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
import type { StockEdits } from '@/hooks/use-stock-edits.ts';

// Asks before an edit drops below what a plan has set aside.
export function ReleaseReservationsDialog({
  edits,
}: {
  edits: StockEdits;
}): React.ReactElement {
  const deleting = edits.confirming?.edit.kind === 'delete';
  return (
    <AlertDialog
      open={edits.confirming !== null}
      onOpenChange={(open) => {
        if (!open) edits.cancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {deleting
              ? 'Remove food set aside for a plan?'
              : 'Use food set aside for a plan?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleting
              ? 'A plan is counting on some of this. Removing it frees those meals or shopping lines to be planned again.'
              : 'A plan is counting on more of this than will be left. The meals or shopping lines it no longer covers will be freed.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              void edits.confirm();
            }}
          >
            {deleting ? 'Remove' : 'Lower it'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
