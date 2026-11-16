import type {
  StapleState,
  StorageLocation,
  StorageStaple,
} from '@loftys-larder/shared';
import { X } from 'lucide-react';
import { useId, useState } from 'react';

import { LOCATION_LABELS } from '@/components/storage/location-tabs.tsx';
import { StapleStateToggle } from '@/components/storage/staple-state-toggle.tsx';
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
import { Button } from '@/components/ui/button.tsx';
import type { StapleMarking } from '@/hooks/use-staple-marking.ts';
import { trpc } from '@/lib/trpc.ts';

// A location's Staples (DEC-118), each with its one-tap state. New ones are
// added from the Storage screen's Add dialog.
export function StaplesSection({
  location,
  staples,
  marking,
}: {
  location: StorageLocation;
  staples: StorageStaple[];
  marking: StapleMarking;
}): React.ReactElement {
  const fieldId = useId();
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [removing, setRemoving] = useState<StorageStaple | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const setState = trpc.ingredients.setStapleState.useMutation({
    onSettled: async () => {
      setSavingId(null);
      await Promise.all([
        utils.storage.list.invalidate(),
        utils.shopping.getForPlan.invalidate(),
      ]);
    },
  });
  const here = staples.filter((staple) => staple.location === location);
  const label = LOCATION_LABELS[location];

  function change(staple: StorageStaple, state: StapleState): void {
    setError(null);
    setSavingId(staple.ingredientId);
    setState.mutate(
      { id: staple.ingredientId, state },
      {
        onError: () => {
          setError(`Couldn’t update ${staple.name}. Try again.`);
        },
      },
    );
  }

  async function remove(staple: StorageStaple): Promise<void> {
    setRemoveError(null);
    setRemovePending(true);
    try {
      await marking.save(
        { id: staple.ingredientId, patch: { stapleLocation: null } },
        staple.name,
        () => undefined,
      );
      setRemoving(null);
    } catch {
      setRemoveError(`Couldn’t remove ${staple.name}. Try again.`);
    } finally {
      setRemovePending(false);
    }
  }

  return (
    <section aria-labelledby={`${fieldId}-title`} className="space-y-2">
      <h2
        id={`${fieldId}-title`}
        className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Staples
      </h2>
      {here.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Staples in the {label.toLowerCase()}.
        </p>
      ) : (
        <ul className="divide-y">
          {here.map((staple) => (
            <li
              key={staple.ingredientId}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="min-w-0 truncate font-medium">
                {staple.name}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <StapleStateToggle
                  name={staple.name}
                  state={staple.state}
                  disabled={savingId === staple.ingredientId}
                  onChange={(state) => {
                    change(staple, state);
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${staple.name} from Staples`}
                  onClick={() => {
                    setRemoveError(null);
                    setRemoving(staple);
                  }}
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !removePending) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removing?.name} from Staples?
            </AlertDialogTitle>
            <AlertDialogDescription>
              It stays in your ingredients, but its state is forgotten and it
              won’t come onto shopping lists to restock.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError && (
            <p role="alert" className="text-sm text-destructive">
              {removeError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removePending}>
              Keep it
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={removePending}
              onClick={(event) => {
                event.preventDefault();
                if (removing) void remove(removing);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
