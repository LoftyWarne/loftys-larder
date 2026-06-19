import type { ShoppingListLine } from '@loftys-larder/shared';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';

import { CategorySection } from '@/components/shopping/category-section.tsx';
import { useOptimisticCheckToggle } from '@/hooks/use-optimistic-check-toggle.ts';
import { trpc } from '@/lib/trpc.ts';

export function ShoppingListPage(): React.ReactElement {
  const params = useParams({ from: '/_authed/plans/$planId_/shopping' });
  const planId = Number.parseInt(params.planId, 10);
  const idIsValid = Number.isInteger(planId) && planId > 0;

  const listQuery = trpc.shopping.getForPlan.useQuery(
    { planId },
    { enabled: idIsValid },
  );

  const [mutationError, setMutationError] = useState<string | null>(null);
  const { toggle } = useOptimisticCheckToggle({
    planId,
    onError: (err) => {
      setMutationError(
        err instanceof Error ? err.message : 'Could not update line',
      );
    },
  });

  function handleToggle(line: ShoppingListLine, nextChecked: boolean): void {
    setMutationError(null);
    toggle({
      planId,
      ingredientId: line.ingredient.id,
      isChecked: nextChecked,
    });
  }

  if (!idIsValid) {
    return <p role="alert">Invalid plan id.</p>;
  }
  if (listQuery.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading shopping list…
      </p>
    );
  }
  if (listQuery.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {listQuery.error.message}
      </p>
    );
  }
  if (!listQuery.data) return <p role="alert">Shopping list not found.</p>;

  const list = listQuery.data;
  const hasLines = list.categories.some((cat) => cat.lines.length > 0);

  return (
    <section
      data-shopping-list-page
      className="mx-auto w-full max-w-3xl space-y-6"
    >
      <header className="space-y-1" data-print-hide>
        <h1 className="text-2xl font-semibold">Shopping list</h1>
        <p className="text-sm text-muted-foreground">
          Tap items off as you shop. The list refreshes when you reload.
        </p>
      </header>
      {mutationError && (
        <p role="alert" className="text-sm text-destructive">
          {mutationError}
        </p>
      )}
      {hasLines ? (
        <div className="space-y-6">
          {list.categories.map((cat) => (
            <CategorySection
              key={cat.category.id}
              category={cat}
              onToggle={handleToggle}
            />
          ))}
        </div>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Nothing to shop for — this plan has no ingredient-bearing slots yet.
        </p>
      )}
    </section>
  );
}
