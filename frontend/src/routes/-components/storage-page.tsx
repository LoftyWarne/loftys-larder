import {
  STORAGE_LOCATIONS,
  type StockItem,
  type StorageLocation,
} from '@loftys-larder/shared';
import { Link, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import {
  LOCATION_LABELS,
  LocationTabs,
} from '@/components/storage/location-tabs.tsx';
import { ReleaseReservationsDialog } from '@/components/storage/release-reservations-dialog.tsx';
import { StockAddSheet } from '@/components/storage/stock-add-sheet.tsx';
import { StockEditSheet } from '@/components/storage/stock-edit-sheet.tsx';
import { StockRow } from '@/components/storage/stock-row.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useStockEdits } from '@/hooks/use-stock-edits.ts';
import { groupStorage, type StorageRow } from '@/lib/storage-rows.ts';
import { trpc } from '@/lib/trpc.ts';

function RowGroup({
  title,
  rows,
  location,
  today,
  edits,
  onEdit,
}: {
  title: string;
  rows: StorageRow[];
  location: StorageLocation;
  today: string;
  edits: ReturnType<typeof useStockEdits>;
  onEdit: (item: StockItem) => void;
}): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-1">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <ul className="divide-y">
        {rows.map((row) => (
          <StockRow
            key={row.key}
            row={row}
            location={location}
            today={today}
            edits={edits}
            onEdit={onEdit}
          />
        ))}
      </ul>
    </section>
  );
}

export function StoragePage(): React.ReactElement {
  const { location } = useSearch({ from: '/_authed/storage' });
  const listQuery = trpc.storage.list.useQuery();
  const edits = useStockEdits();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const items = listQuery.data?.items;
  const today = listQuery.data?.today;
  const groups = useMemo(
    () => groupStorage(items ?? [], location),
    [items, location],
  );
  const counts = useMemo(() => {
    const result = { freezer: 0, fridge: 0, pantry: 0 };
    for (const value of STORAGE_LOCATIONS) {
      const grouped = groupStorage(items ?? [], value);
      result[value] = grouped.ingredients.length + grouped.dishes.length;
    }
    return result;
  }, [items]);
  const editing = items?.find((item) => item.id === editingId) ?? null;
  const empty = groups.ingredients.length === 0 && groups.dishes.length === 0;

  return (
    <section className="mx-auto max-w-3xl space-y-4">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Storage</h1>
        <div className="flex items-center gap-3">
          <Link
            to="/ingredients"
            className="text-sm text-primary underline-offset-2 hover:underline"
          >
            Ingredients
          </Link>
          <Button
            disabled={today === undefined}
            onClick={() => {
              setAdding(true);
            }}
          >
            Add
          </Button>
        </div>
      </header>

      <LocationTabs current={location} counts={counts} />

      {listQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {listQuery.error && (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t load storage. Try again.
        </p>
      )}
      {edits.error && editing === null && (
        <p role="alert" className="text-sm text-destructive">
          {edits.error}
        </p>
      )}

      {today !== undefined && (
        <>
          {empty && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing in the {LOCATION_LABELS[location].toLowerCase()} yet.
            </p>
          )}
          <RowGroup
            title="Ingredients"
            rows={groups.ingredients}
            location={location}
            today={today}
            edits={edits}
            onEdit={(item) => {
              setEditingId(item.id);
            }}
          />
          <RowGroup
            title="Dishes"
            rows={groups.dishes}
            location={location}
            today={today}
            edits={edits}
            onEdit={(item) => {
              setEditingId(item.id);
            }}
          />
          <StockAddSheet
            open={adding}
            onOpenChange={setAdding}
            location={location}
            today={today}
          />
          <StockEditSheet
            item={editing}
            today={today}
            edits={edits}
            onClose={() => {
              setEditingId(null);
            }}
          />
        </>
      )}
      <ReleaseReservationsDialog edits={edits} />
    </section>
  );
}
