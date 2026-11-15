import {
  defaultUseBy,
  isValidPortions,
  stockItemEditFormSchema,
  STORAGE_LOCATIONS,
  type StockItem,
  type StockItemEditForm,
  type StorageLocation,
  type UseByTarget,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';

import { LOCATION_LABELS } from '@/components/storage/location-tabs.tsx';
import { SELECT_CLASS } from '@/components/storage/stock-add-sheet.tsx';
import { Button } from '@/components/ui/button.tsx';
import { DateInput } from '@/components/ui/date-input.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { StockEdits } from '@/hooks/use-stock-edits.ts';

function shelfLifeTargetOf(item: StockItem): UseByTarget {
  return item.target.kind === 'recipe'
    ? { kind: 'recipe' }
    : {
        kind: 'ingredient',
        averageShelfLifeDays: item.target.averageShelfLifeDays,
      };
}

function trimQuantity(quantity: string): string {
  return quantity.includes('.') ? quantity.replace(/\.?0+$/, '') : quantity;
}

interface StockEditSheetProps {
  item: StockItem | null;
  today: string;
  edits: StockEdits;
  onClose: () => void;
}

// Location, amount, date and Use-by for one Stock item. Moving it into the
// Fridge sets a fresh default Use-by from today; moving it out clears it.
export function StockEditSheet({
  item,
  today,
  edits,
  onClose,
}: StockEditSheetProps): React.ReactElement {
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {item && (
          <EditForm
            key={item.id}
            item={item}
            today={today}
            edits={edits}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({
  item,
  today,
  edits,
  onClose,
}: {
  item: StockItem;
  today: string;
  edits: StockEdits;
  onClose: () => void;
}): React.ReactElement {
  const fieldId = useId();
  const [portionsError, setPortionsError] = useState<string | null>(null);
  const form = useForm<StockItemEditForm>({
    resolver: zodResolver(stockItemEditFormSchema),
    defaultValues: {
      location: item.location,
      quantity: trimQuantity(item.quantity),
      addedOn: item.addedOn,
      useBy: item.useBy ?? '',
    },
  });
  const location = form.watch('location');
  const errors = form.formState.errors;
  const unitLabel =
    item.target.kind === 'recipe' ? 'portions' : item.target.unitName;

  function onLocationChange(next: StorageLocation): void {
    if (next !== 'fridge') {
      form.setValue('useBy', '');
    } else if (item.location !== 'fridge') {
      form.setValue(
        'useBy',
        defaultUseBy(today, shelfLifeTargetOf(item)) ?? '',
      );
    } else {
      form.setValue('useBy', item.useBy ?? '');
    }
  }

  const submit = form.handleSubmit(async (values) => {
    setPortionsError(null);
    if (item.target.kind === 'recipe' && !isValidPortions(values.quantity)) {
      setPortionsError('Portions must be whole or half');
      return;
    }
    await edits.run(
      {
        kind: 'update',
        input: {
          id: item.id,
          patch: {
            location: values.location,
            quantity: values.quantity,
            addedOn: values.addedOn,
            useBy:
              values.location === 'fridge' && values.useBy !== ''
                ? values.useBy
                : null,
          },
        },
      },
      onClose,
    );
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{item.target.name}</DialogTitle>
        <DialogDescription>
          Change where it’s kept, how much there is, or its dates. An amount of
          0 removes it.
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label
              htmlFor={`${fieldId}-quantity`}
              className="text-sm font-medium"
            >
              Amount
            </label>
            <div className="flex items-center gap-2">
              <Input
                id={`${fieldId}-quantity`}
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={
                  errors.quantity || portionsError ? true : undefined
                }
                aria-describedby={`${fieldId}-unit`}
                {...form.register('quantity')}
              />
              <span
                id={`${fieldId}-unit`}
                className="text-sm text-muted-foreground"
              >
                {unitLabel}
              </span>
            </div>
            {(errors.quantity ?? portionsError) && (
              <p role="alert" className="text-sm text-destructive">
                {errors.quantity?.message ?? portionsError}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label
              htmlFor={`${fieldId}-location`}
              className="text-sm font-medium"
            >
              Where
            </label>
            <select
              id={`${fieldId}-location`}
              className={SELECT_CLASS}
              {...form.register('location', {
                onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                  onLocationChange(event.target.value as StorageLocation);
                },
              })}
            >
              {STORAGE_LOCATIONS.map((value) => (
                <option key={value} value={value}>
                  {LOCATION_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label htmlFor={`${fieldId}-added`} className="text-sm font-medium">
              {location === 'freezer' ? 'Frozen on' : 'Added on'}
            </label>
            <DateInput
              id={`${fieldId}-added`}
              max={today}
              aria-invalid={errors.addedOn ? true : undefined}
              {...form.register('addedOn')}
            />
          </div>
          {location === 'fridge' && (
            <div className="space-y-1">
              <label
                htmlFor={`${fieldId}-use-by`}
                className="text-sm font-medium"
              >
                Use by
              </label>
              <DateInput id={`${fieldId}-use-by`} {...form.register('useBy')} />
            </div>
          )}
        </div>

        {edits.error && (
          <p role="alert" className="text-sm text-destructive">
            {edits.error}
          </p>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="destructive"
            disabled={edits.pending}
            onClick={() => {
              void edits.run({ kind: 'delete', id: item.id }, onClose);
            }}
          >
            Remove
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={edits.pending}>
              Save
            </Button>
          </div>
        </DialogFooter>
      </form>
    </>
  );
}
