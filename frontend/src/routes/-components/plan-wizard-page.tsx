import type {
  CreatePlanInput,
  PlanOccasion,
  ProposePlanResult,
} from '@loftys-larder/shared';
import { useBlocker, useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';

import { AttendanceStep } from '@/components/plan-wizard/attendance-step.tsx';
import { BriefStep } from '@/components/plan-wizard/brief-step.tsx';
import { DatesStep } from '@/components/plan-wizard/dates-step.tsx';
import { FixedMealsStep } from '@/components/plan-wizard/fixed-meals-step.tsx';
import { PlanReview } from '@/components/plan-wizard/plan-review.tsx';
import { ProposalStatus } from '@/components/plan-wizard/proposal-status.tsx';
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
import { useOnlineStatus } from '@/hooks/use-online-status.ts';
import { addCivilDays, todayInLondon } from '@/lib/date-utils.ts';
import { planErrorMessage } from '@/lib/plan-errors.ts';
import {
  buildApplyInput,
  buildProposeInput,
  defaultAttendance,
  inputsSignature,
  pruneFixedMeals,
  rerunReview,
  startReview,
  wizardSlots,
  type AttendanceSettings,
  type FixedChoice,
  type ReviewState,
  type WizardInputs,
} from '@/lib/plan-wizard.ts';
import {
  applyErrorMessage,
  proposalErrorMessage,
} from '@/lib/plan-proposal-errors.ts';
import { trpc } from '@/lib/trpc.ts';

type Step = 'dates' | 'attendance' | 'fixed' | 'brief' | 'proposing' | 'review';

const DEFAULT_LENGTH_DAYS = 6;

// The planning wizard (DEC-117): dates, who's eating, Fixed meals and a
// Brief, then a Plan Proposal reviewed in Plan Review. Everything lives in
// React state (DEC-09); nothing exists until Apply creates the plan.
export function PlanWizardPage(): React.ReactElement {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  // The wizard's model calls are off while offline (DEC-117).
  const isOnline = useOnlineStatus();
  const membersQuery = trpc.user.listHouseholdMembers.useQuery();
  const members = useMemo(
    () => membersQuery.data?.members ?? [],
    [membersQuery.data],
  );

  const [step, setStep] = useState<Step>('dates');
  const [dates, setDates] = useState<CreatePlanInput>(() => {
    const start = addCivilDays(todayInLondon(), 1);
    return {
      startDate: start,
      endDate: addCivilDays(start, DEFAULT_LENGTH_DAYS),
    };
  });
  const [occasions, setOccasions] = useState<readonly PlanOccasion[]>([]);
  const [attendance, setAttendance] = useState<AttendanceSettings | null>(null);
  const [fixed, setFixed] = useState<ReadonlyMap<string, FixedChoice>>(
    new Map(),
  );
  const [brief, setBrief] = useState('');
  const [review, setReview] = useState<ReviewState | null>(null);
  const [reviewSignature, setReviewSignature] = useState<string | null>(null);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [anotherGoError, setAnotherGoError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [confirmNewProposal, setConfirmNewProposal] = useState(false);
  const applied = useRef(false);

  const proposeMutation = trpc.planProposals.propose.useMutation();
  const applyMutation = trpc.plans.createWithSlots.useMutation();

  const inputs = useMemo<WizardInputs | null>(
    () =>
      attendance ? { ...dates, occasions, attendance, fixed, brief } : null,
    [dates, occasions, attendance, fixed, brief],
  );
  const slots = useMemo(
    () => wizardSlots(dates.startDate, dates.endDate, occasions),
    [dates, occasions],
  );

  // Leaving, or reloading, with a proposal on screen loses it, so ask first.
  const hasProposal = review !== null;
  const blocker = useBlocker({
    shouldBlockFn: () => hasProposal && !applied.current,
    enableBeforeUnload: () => hasProposal && !applied.current,
    withResolver: true,
  });

  async function handleDates(values: CreatePlanInput): Promise<string | null> {
    try {
      const result = await utils.plans.checkNewDates.fetch(values);
      const known =
        attendance ??
        defaultAttendance(
          (await utils.user.listHouseholdMembers.fetch()).members.map(
            (member) => member.id,
          ),
        );
      setDates(values);
      setOccasions(result.occasions);
      setAttendance(known);
      setFixed((prev) =>
        pruneFixedMeals(
          { attendance: known, fixed: prev },
          wizardSlots(values.startDate, values.endDate, result.occasions),
        ),
      );
      setStep('attendance');
      return null;
    } catch (err) {
      return planErrorMessage(err, 'Those dates couldn’t be checked.');
    }
  }

  function handleAttendance(next: AttendanceSettings) {
    setAttendance(next);
    setFixed((prev) =>
      pruneFixedMeals({ attendance: next, fixed: prev }, slots),
    );
  }

  async function propose(current: WizardInputs, note: string | null) {
    const rerun = note !== null && review !== null ? { review, note } : null;
    if (rerun) setAnotherGoError(null);
    else {
      setProposeError(null);
      setStep('proposing');
    }
    let proposal: ProposePlanResult;
    try {
      proposal = await proposeMutation.mutateAsync(
        buildProposeInput(current, rerun),
      );
    } catch (err) {
      const message = proposalErrorMessage(err);
      if (rerun) setAnotherGoError(message);
      else setProposeError(message);
      return;
    }
    setReview(
      rerun ? rerunReview(rerun.review, proposal) : startReview(proposal),
    );
    setReviewSignature(inputsSignature(current));
    setStep('review');
  }

  function handleBrief(nextBrief: string) {
    setBrief(nextBrief);
    if (!inputs) return;
    const current = { ...inputs, brief: nextBrief };
    if (review && reviewSignature === inputsSignature(current)) {
      setStep('review');
      return;
    }
    if (review) {
      setConfirmNewProposal(true);
      return;
    }
    void propose(current, null);
  }

  function startNewProposal() {
    setConfirmNewProposal(false);
    if (!inputs) return;
    setReview(null);
    setReviewSignature(null);
    void propose(inputs, null);
  }

  async function handleApply() {
    if (!inputs || !review) return;
    setApplyError(null);
    try {
      const { plan } = await applyMutation.mutateAsync(
        buildApplyInput(inputs, review),
      );
      applied.current = true;
      await utils.plans.list.invalidate();
      await navigate({
        to: '/plans/$planId',
        params: { planId: String(plan.id) },
      });
    } catch (err) {
      setApplyError(applyErrorMessage(err));
    }
  }

  return (
    <section className="mx-auto w-full max-w-6xl space-y-4">
      <h1 className="text-lg font-semibold md:text-2xl">Plan with AI</h1>

      {step === 'dates' && (
        <DatesStep defaultValues={dates} onSubmit={handleDates} />
      )}
      {step === 'attendance' && attendance && (
        <AttendanceStep
          members={members}
          occasions={occasions}
          slots={slots}
          value={attendance}
          onChange={handleAttendance}
          onBack={() => {
            setStep('dates');
          }}
          onNext={() => {
            setStep('fixed');
          }}
        />
      )}
      {step === 'fixed' && attendance && (
        <FixedMealsStep
          slots={slots}
          attendance={attendance}
          value={fixed}
          onChange={setFixed}
          onBack={() => {
            setStep('attendance');
          }}
          onNext={() => {
            setStep('brief');
          }}
        />
      )}
      {step === 'brief' && (
        <BriefStep
          brief={brief}
          nextLabel={review ? 'Back to review' : 'Plan my meals'}
          offline={!isOnline && !review}
          onBack={(value) => {
            setBrief(value);
            setStep('fixed');
          }}
          onSubmit={handleBrief}
        />
      )}
      {step === 'proposing' && (
        <ProposalStatus
          error={proposeError}
          offline={!isOnline}
          onRetry={() => {
            if (inputs) void propose(inputs, null);
          }}
          onBack={() => {
            setStep('brief');
          }}
        />
      )}
      {step === 'review' && inputs && review && (
        <PlanReview
          inputs={inputs}
          review={review}
          members={members}
          onReviewChange={setReview}
          onAnotherGo={(note) => {
            void propose(inputs, note);
          }}
          anotherGoPending={proposeMutation.isPending}
          anotherGoError={anotherGoError}
          offline={!isOnline}
          onApply={() => {
            void handleApply();
          }}
          applyPending={applyMutation.isPending}
          applyError={applyError}
          onBack={() => {
            setStep('brief');
          }}
        />
      )}

      <AlertDialog
        open={confirmNewProposal}
        onOpenChange={(open) => {
          if (!open) setConfirmNewProposal(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make a new plan?</AlertDialogTitle>
            <AlertDialogDescription>
              You’ve changed the plan’s details, so the current proposal and
              your changes to it will be replaced.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={startNewProposal} disabled={!isOnline}>
              Make a new plan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.status === 'blocked') blocker.reset();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without applying?</AlertDialogTitle>
            <AlertDialogDescription>
              No plan has been created yet. The proposal will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (blocker.status === 'blocked') blocker.reset();
              }}
            >
              Stay
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (blocker.status === 'blocked') blocker.proceed();
              }}
            >
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
