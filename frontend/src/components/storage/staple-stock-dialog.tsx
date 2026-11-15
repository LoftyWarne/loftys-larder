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
import type { StapleMarking } from '@/hooks/use-staple-marking.ts';

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

// Asks before marking a held ingredient as a Staple deletes its stock.
export function StapleStockDialog({
  marking,
}: {
  marking: StapleMarking;
}): React.ReactElement {
  const confirming = marking.confirming;
  return (
    <AlertDialog
      open={confirming !== null}
      onOpenChange={(open) => {
        if (!open) marking.cancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove it from storage?</AlertDialogTitle>
          <AlertDialogDescription>
            {confirming &&
              `${confirming.name} is held in storage as ${plural(confirming.stockItems, 'item', 'items')}. A Staple is tracked by whether you have it, not by amount, so ${confirming.stockItems === 1 ? 'it' : 'they'} will be removed.`}
            {confirming &&
              confirming.reservations > 0 &&
              ' Shopping lines or meals counting on it will be freed.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {marking.error && (
          <p role="alert" className="text-sm text-destructive">
            {marking.error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it in storage</AlertDialogCancel>
          <AlertDialogAction
            disabled={marking.isPending}
            onClick={(event) => {
              event.preventDefault();
              void marking.confirm();
            }}
          >
            Make it a Staple
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
