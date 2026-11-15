import type { StorageLocation } from '@loftys-larder/shared';

import { LOCATION_LABELS } from '@/components/storage/location-tabs.tsx';
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
import { formatStockAmount, type StorageRow } from '@/lib/storage-rows.ts';

// Asks before a Storage row goes, with every Stock item it combines.
export function RemoveStockDialog({
  row,
  location,
  edits,
  onClose,
}: {
  row: StorageRow | null;
  location: StorageLocation;
  edits: StockEdits;
  onClose: () => void;
}): React.ReactElement {
  const where = LOCATION_LABELS[location].toLowerCase();
  const reserved = row !== null && row.reservedMilli > 0;
  return (
    <AlertDialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove {row?.target.name} from the {where}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {row &&
              (row.items.length > 1
                ? `All ${String(row.items.length)} items, ${formatStockAmount(row.totalMilli, row.target)} in total, will be removed.`
                : `${formatStockAmount(row.totalMilli, row.target)} will be removed.`)}
            {reserved &&
              ' A plan is counting on some of this. Removing it frees those meals or shopping lines to be planned again.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (!row) return;
              const ids = row.items.map((item) => item.id);
              onClose();
              void edits.run({ kind: 'deleteMany', ids }, undefined, {
                release: reserved,
              });
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
