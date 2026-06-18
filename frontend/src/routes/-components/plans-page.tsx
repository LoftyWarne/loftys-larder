import type {
  CreatePlanInput,
  DuplicatePlanInput,
  PlanListItem,
  PlanStatus,
} from '@loftys-larder/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { DuplicatePlanDialog } from '@/components/planner/duplicate-plan-dialog.tsx';
import { NewPlanDialog } from '@/components/planner/new-plan-dialog.tsx';
import { PlanListCard } from '@/components/planner/plan-list-card.tsx';
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
import { todayInLondon } from '@/lib/date-utils.ts';
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import { trpc } from '@/lib/trpc.ts';

const STATUS_OPTIONS: readonly { value: PlanStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'past', label: 'Past' },
  { value: 'future', label: 'Future' },
  { value: 'all', label: 'All' },
];

const EMPTY_MESSAGES: Record<PlanStatus, string> = {
  active: 'No active plan. Create one to get started.',
  past: 'No past plans yet.',
  future: 'No future plans scheduled.',
  all: 'No plans yet. Create one to get started.',
};

const PLAN_DEFAULT_DURATION_DAYS = 6;

// Walks a civil date forward by N days in UTC. The wider date-utils module
// works in string-space too but doesn't expose a single-step "advance"
// helper; a six-line inline avoids widening that module's surface area.
function advance(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const ts = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  const next = new Date(ts);
  const year = String(next.getUTCFullYear()).padStart(4, '0');
  const month = String(next.getUTCMonth() + 1).padStart(2, '0');
  const day = String(next.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function PlansPage(): React.ReactElement {
  const search = useSearch({ from: '/_authed/plans/' });
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const listQuery = trpc.plans.list.useQuery({ status: search.status });

  const [newPlanOpen, setNewPlanOpen] = useState(false);
  const [newPlanError, setNewPlanError] = useState<string | null>(null);
  const [duplicateTarget, setDuplicateTarget] = useState<PlanListItem | null>(
    null,
  );
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PlanListItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const createMutation = trpc.plans.create.useMutation();
  const duplicateMutation = trpc.plans.duplicate.useMutation();
  const deleteMutation = trpc.plans.delete.useMutation({
    onMutate: async ({ id }) => {
      await utils.plans.list.cancel({ status: search.status });
      const previous = utils.plans.list.getData({ status: search.status });
      if (previous) {
        utils.plans.list.setData(
          { status: search.status },
          { items: previous.items.filter((plan) => plan.id !== id) },
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        utils.plans.list.setData({ status: search.status }, ctx.previous);
      }
    },
    onSettled: async () => {
      await utils.plans.list.invalidate();
    },
  });

  const defaultStart = useMemo(() => todayInLondon(), []);
  const defaultEnd = useMemo(
    () => advance(defaultStart, PLAN_DEFAULT_DURATION_DAYS),
    [defaultStart],
  );
  const defaultDuplicateStart = useMemo(
    () => advance(defaultStart, 1),
    [defaultStart],
  );

  async function handleCreate(values: CreatePlanInput): Promise<void> {
    setNewPlanError(null);
    try {
      const result = await createMutation.mutateAsync(values);
      await utils.plans.list.invalidate();
      setNewPlanOpen(false);
      await navigate({
        to: '/plans/$planId',
        params: { planId: String(result.plan.id) },
      });
    } catch (err) {
      setNewPlanError(translateError(err, 'Could not create plan.'));
    }
  }

  async function handleDuplicate(values: DuplicatePlanInput): Promise<void> {
    setDuplicateError(null);
    try {
      const result = await duplicateMutation.mutateAsync(values);
      await utils.plans.list.invalidate();
      setDuplicateTarget(null);
      await navigate({
        to: '/plans/$planId',
        params: { planId: String(result.plan.id) },
      });
    } catch (err) {
      setDuplicateError(translateError(err, 'Could not duplicate plan.'));
    }
  }

  async function handleConfirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync({ id: deleteTarget.id });
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(translateError(err, 'Could not delete plan.'));
    }
  }

  function handleStatusChange(next: PlanStatus): void {
    void navigate({ to: '/plans', search: { status: next } });
  }

  const plans = listQuery.data?.items ?? [];

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Plans</h1>
        <Button
          onClick={() => {
            setNewPlanError(null);
            setNewPlanOpen(true);
          }}
        >
          New plan
        </Button>
      </header>

      <div
        className="flex flex-wrap gap-2"
        role="radiogroup"
        aria-label="Filter plans by status"
      >
        {STATUS_OPTIONS.map((option) => {
          const isActive = search.status === option.value;
          return (
            <Button
              key={option.value}
              variant={isActive ? 'default' : 'outline'}
              size="sm"
              role="radio"
              aria-checked={isActive}
              onClick={() => {
                handleStatusChange(option.value);
              }}
            >
              {option.label}
            </Button>
          );
        })}
      </div>

      {listQuery.isLoading && <p role="status">Loading plans…</p>}

      {listQuery.error && (
        <p role="alert" className="text-sm text-destructive">
          Could not load plans: {listQuery.error.message}
        </p>
      )}

      {!listQuery.isLoading && !listQuery.error && plans.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {EMPTY_MESSAGES[search.status]}
        </p>
      )}

      {plans.length > 0 && (
        <ul className="space-y-3">
          {plans.map((plan) => (
            <li key={plan.id}>
              <PlanListCard
                plan={plan}
                onDuplicate={(target) => {
                  setDuplicateError(null);
                  setDuplicateTarget(target);
                }}
                onDelete={(target) => {
                  setDeleteError(null);
                  setDeleteTarget(target);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <NewPlanDialog
        open={newPlanOpen}
        onOpenChange={(open) => {
          setNewPlanOpen(open);
          if (!open) setNewPlanError(null);
        }}
        onSubmit={handleCreate}
        serverError={newPlanError}
        defaultStartDate={defaultStart}
        defaultEndDate={defaultEnd}
        isSubmitting={createMutation.isPending}
      />

      <DuplicatePlanDialog
        open={duplicateTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDuplicateTarget(null);
            setDuplicateError(null);
          }
        }}
        source={
          duplicateTarget
            ? {
                id: duplicateTarget.id,
                startDate: duplicateTarget.startDate,
                endDate: duplicateTarget.endDate,
              }
            : null
        }
        onSubmit={handleDuplicate}
        serverError={duplicateError}
        defaultNewStartDate={defaultDuplicateStart}
        isSubmitting={duplicateMutation.isPending}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        {deleteTarget && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete plan?</AlertDialogTitle>
              <AlertDialogDescription>
                Delete the plan for {deleteTarget.startDate} –{' '}
                {deleteTarget.endDate}? This removes all of its slots and cannot
                be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError && (
              <p role="alert" className="text-sm text-destructive">
                {deleteError}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMutation.isPending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  void handleConfirmDelete();
                }}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </section>
  );
}

function translateError(err: unknown, fallback: string): string {
  const code = getDomainErrorCode(err);
  if (code === 'PLAN_DATE_OVERLAP') {
    return 'That range overlaps an existing active or future plan.';
  }
  if (code === 'PLAN_RANGE_TOO_LONG') {
    return 'Plan range cannot exceed 14 days.';
  }
  if (code === 'PLAN_PAST_NOT_EDITABLE') {
    return 'Past plans cannot be edited.';
  }
  return err instanceof Error ? err.message : fallback;
}
