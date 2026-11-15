import {
  STORAGE_LOCATIONS,
  type StockItem,
  type StorageLocation,
} from '@loftys-larder/shared';
import { useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import {
  LOCATION_LABELS,
  LocationTabs,
} from '@/components/storage/location-tabs.tsx';
import { ReleaseReservationsDialog } from '@/components/storage/release-reservations-dialog.tsx';
import { RemoveStockDialog } from '@/components/storage/remove-stock-dialog.tsx';
import { StapleStockDialog } from '@/components/storage/staple-stock-dialog.tsx';
import { StaplesSection } from '@/components/storage/staples-section.tsx';
import { StockAddSheet } from '@/components/storage/stock-add-sheet.tsx';
import { StockEditSheet } from '@/components/storage/stock-edit-sheet.tsx';
import { StockRow } from '@/components/storage/stock-row.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useStapleMarking } from '@/hooks/use-staple-marking.ts';
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
  onRemove,
}: {
  title: string;
  rows: StorageRow[];
  location: StorageLocation;
  today: string;
  edits: ReturnType<typeof useStockEdits>;
  onEdit: (item: StockItem) => void;
  onRemove: (row: StorageRow) => void;
}): React.ReactElement {
  return (
    <section aria-label={title} className="space-y-1">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {title.toLowerCase()} in the{' '}
          {LOCATION_LABELS[location].toLowerCase()}.
        </p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <StockRow
              key={row.key}
              row={row}
              location={location}
              today={today}
              edits={edits}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function StoragePage(): React.ReactElement {
  const { location } = useSearch({ from: '/_authed/storage' });
  const listQuery = trpc.storage.list.useQuery();
  const edits = useStockEdits();
  const stapleMarking = useStapleMarking();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [removingRow, setRemovingRow] = useState<StorageRow | null>(null);

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

  return (
    <section className="mx-auto max-w-3xl space-y-4">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Storage</h1>
        <Button
          disabled={today === undefined}
          onClick={() => {
            setAdding(true);
          }}
        >
          Add
        </Button>
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
          <StaplesSection
            location={location}
            staples={listQuery.data?.staples ?? []}
            marking={stapleMarking}
          />
          <RowGroup
            title="Ingredients"
            rows={groups.ingredients}
            location={location}
            today={today}
            edits={edits}
            onEdit={(item) => {
              setEditingId(item.id);
            }}
            onRemove={setRemovingRow}
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
            onRemove={setRemovingRow}
          />
          <StockAddSheet
            open={adding}
            onOpenChange={setAdding}
            location={location}
            today={today}
            marking={stapleMarking}
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
      <RemoveStockDialog
        row={removingRow}
        location={location}
        edits={edits}
        onClose={() => {
          setRemovingRow(null);
        }}
      />
      <ReleaseReservationsDialog edits={edits} />
      <StapleStockDialog marking={stapleMarking} />
    </section>
  );
}
