import type { IngredientListItem } from '@loftys-larder/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  IngredientForm,
  type IngredientFormValues,
} from '@/components/ingredient-form.tsx';
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
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import { trpc } from '@/lib/trpc.ts';

const SEARCH_DEBOUNCE_MS = 200;

type DeleteState =
  | { kind: 'idle' }
  | { kind: 'confirming'; ingredient: IngredientListItem }
  | {
      kind: 'confirming-error';
      ingredient: IngredientListItem;
      message: string;
    };

export function IngredientsPage(): React.ReactElement {
  const utils = trpc.useUtils();
  const referencesQuery = trpc.ingredients.references.useQuery();

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [searchInput]);

  const listQuery = trpc.ingredients.list.useQuery(
    debouncedSearch ? { search: debouncedSearch } : undefined,
  );

  const [addOpen, setAddOpen] = useState(false);
  const [addNameError, setAddNameError] = useState<string | undefined>();
  const [editTarget, setEditTarget] = useState<IngredientListItem | null>(null);
  const [editNameError, setEditNameError] = useState<string | undefined>();
  const [deleteState, setDeleteState] = useState<DeleteState>({ kind: 'idle' });

  const createMutation = trpc.ingredients.create.useMutation({
    onSuccess: async () => {
      await utils.ingredients.list.invalidate();
    },
  });
  const updateMutation = trpc.ingredients.update.useMutation({
    onSuccess: async () => {
      await utils.ingredients.list.invalidate();
    },
  });
  const deleteMutation = trpc.ingredients.delete.useMutation({
    onSuccess: async () => {
      await utils.ingredients.list.invalidate();
    },
  });

  const addDefaults = useMemo<IngredientFormValues>(() => {
    const firstCategory = referencesQuery.data?.categories[0];
    const firstUnit = referencesQuery.data?.units[0];
    return {
      name: '',
      categoryId: firstCategory ? firstCategory.id : 0,
      defaultUnitId: firstUnit ? firstUnit.id : 0,
      isPlant: false,
      averageShelfLifeDays: null,
    };
  }, [referencesQuery.data]);

  function openAdd(): void {
    setAddNameError(undefined);
    setAddOpen(true);
  }

  async function handleCreate(values: IngredientFormValues): Promise<void> {
    setAddNameError(undefined);
    try {
      await createMutation.mutateAsync(values);
      setAddOpen(false);
    } catch (error) {
      const code = getDomainErrorCode(error);
      if (code === 'INGREDIENT_NAME_TAKEN') {
        setAddNameError('An ingredient with this name already exists');
        return;
      }
      throw error;
    }
  }

  async function handleUpdate(values: IngredientFormValues): Promise<void> {
    if (!editTarget) return;
    setEditNameError(undefined);
    try {
      await updateMutation.mutateAsync({
        id: editTarget.id,
        patch: values,
      });
      setEditTarget(null);
    } catch (error) {
      const code = getDomainErrorCode(error);
      if (code === 'INGREDIENT_NAME_TAKEN') {
        setEditNameError('An ingredient with this name already exists');
        return;
      }
      throw error;
    }
  }

  async function handleConfirmDelete(
    ingredient: IngredientListItem,
  ): Promise<void> {
    try {
      await deleteMutation.mutateAsync({ id: ingredient.id });
      setDeleteState({ kind: 'idle' });
    } catch (error) {
      const code = getDomainErrorCode(error);
      const message =
        code === 'INGREDIENT_IN_USE'
          ? 'This ingredient is used in one or more recipes.'
          : 'Could not delete this ingredient.';
      setDeleteState({ kind: 'confirming-error', ingredient, message });
    }
  }

  const references = referencesQuery.data;
  const ingredients = listQuery.data ?? [];
  const showLoading = referencesQuery.isLoading || listQuery.isLoading;
  const referencesError = referencesQuery.error;

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Ingredients</h1>
        <Button onClick={openAdd} disabled={!references}>
          Add ingredient
        </Button>
      </header>

      <Input
        type="search"
        placeholder="Search by name"
        value={searchInput}
        onChange={(event) => {
          setSearchInput(event.target.value);
        }}
        aria-label="Search ingredients"
      />

      {referencesError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load reference data: {referencesError.message}
        </p>
      )}

      {showLoading && !referencesError && (
        <p role="status">Loading ingredients…</p>
      )}

      {!showLoading && ingredients.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {debouncedSearch
            ? 'No ingredients match your search.'
            : 'No ingredients yet. Add one to get started.'}
        </p>
      )}

      {ingredients.length > 0 && (
        <ul className="divide-y rounded-md border">
          {ingredients.map((ingredient) => (
            <li
              key={ingredient.id}
              className="flex items-center justify-between gap-4 p-3"
              data-testid={`ingredient-row-${String(ingredient.id)}`}
            >
              <div>
                <p className="font-medium">{ingredient.name}</p>
                <p className="text-xs text-muted-foreground">
                  {ingredient.categoryName} · {ingredient.defaultUnitName}
                  {ingredient.isPlant && ' · 🌱'}
                  {ingredient.averageShelfLifeDays !== null &&
                    ` · ${String(ingredient.averageShelfLifeDays)} day shelf life`}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditNameError(undefined);
                    setEditTarget(ingredient);
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setDeleteState({ kind: 'confirming', ingredient });
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {references && (
        <Dialog
          open={addOpen}
          onOpenChange={(open) => {
            if (!open) {
              setAddOpen(false);
              setAddNameError(undefined);
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add ingredient</DialogTitle>
              <DialogDescription>
                Adds a new ingredient to your household.
              </DialogDescription>
            </DialogHeader>
            <IngredientForm
              references={references}
              defaultValues={addDefaults}
              submitLabel="Add ingredient"
              nameError={addNameError}
              onSubmit={handleCreate}
              onCancel={() => {
                setAddOpen(false);
              }}
            />
          </DialogContent>
        </Dialog>
      )}

      {references && editTarget && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditTarget(null);
              setEditNameError(undefined);
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit ingredient</DialogTitle>
              <DialogDescription>
                Updates this ingredient. Existing recipes will pick up the
                change.
              </DialogDescription>
            </DialogHeader>
            <IngredientForm
              key={editTarget.id}
              references={references}
              defaultValues={{
                name: editTarget.name,
                categoryId: editTarget.categoryId,
                defaultUnitId: editTarget.defaultUnitId,
                isPlant: editTarget.isPlant,
                averageShelfLifeDays: editTarget.averageShelfLifeDays,
              }}
              submitLabel="Save changes"
              nameError={editNameError}
              onSubmit={handleUpdate}
              onCancel={() => {
                setEditTarget(null);
              }}
            />
          </DialogContent>
        </Dialog>
      )}

      <Dialog
        open={deleteState.kind !== 'idle'}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteState({ kind: 'idle' });
          }
        }}
      >
        {deleteState.kind !== 'idle' && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete ingredient?</DialogTitle>
              <DialogDescription>
                Delete &ldquo;{deleteState.ingredient.name}&rdquo; from your
                household? This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {deleteState.kind === 'confirming-error' && (
              <p role="alert" className="text-sm text-destructive">
                {deleteState.message}
              </p>
            )}
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setDeleteState({ kind: 'idle' });
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  void handleConfirmDelete(deleteState.ingredient);
                }}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
