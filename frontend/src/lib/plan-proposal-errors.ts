import { getDomainErrorCause, getDomainErrorCode } from '@/lib/domain-error.ts';
import { planErrorMessage } from '@/lib/plan-errors.ts';

// How a failed Plan Proposal reads to the cook (DEC-117). The date codes use
// plan creation's words.
export function proposalErrorMessage(err: unknown): string {
  const cause = getDomainErrorCause(err);
  switch (cause?.code) {
    case 'MEAL_PLAN_RATE_LIMITED':
      return `You’ve asked for a lot of plans recently. Try again in ${retryIn(cause.retryAfterSeconds)}.`;
    case 'MEAL_PLAN_TRY_AGAIN':
      return 'The plan didn’t work. Try again.';
    case 'MEAL_PLAN_NOT_PROPOSED':
    case 'MEAL_PLAN_REQUEST_REJECTED':
      return 'A plan couldn’t be made. Try changing the brief.';
    case 'MEAL_PLAN_NO_RECIPES':
      return 'There are no recipes to plan from yet. Add some recipes first.';
    case 'MEAL_PLAN_BATCH_TOO_SMALL':
      return 'A batch cooks fewer portions than the people eating at its meal. Go back to the fixed meals and cook more.';
    default:
      return planErrorMessage(err, 'The plan didn’t work. Try again.');
  }
}

// How a failed Suggest again reads, for one slot. Its own limit, then the
// whole plan's messages in a slot's words where they differ.
export function slotSuggestionErrorMessage(err: unknown): string {
  const cause = getDomainErrorCause(err);
  switch (cause?.code) {
    case 'MEAL_PLAN_SLOT_RATE_LIMITED':
      return `You’ve asked for a lot of suggestions recently. Try again in ${retryIn(cause.retryAfterSeconds)}.`;
    case 'MEAL_PLAN_TRY_AGAIN':
      return 'That suggestion didn’t work. Try again.';
    case 'MEAL_PLAN_NOT_PROPOSED':
    case 'MEAL_PLAN_REQUEST_REJECTED':
      return 'A new suggestion couldn’t be made for this meal. Try again later.';
    default:
      return proposalErrorMessage(err);
  }
}

function retryIn(seconds: unknown): string {
  const minutes = Math.max(
    1,
    Math.ceil((typeof seconds === 'number' ? seconds : 0) / 60),
  );
  return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

const APPLY_FAILED = 'The plan couldn’t be created. Try again.';

// How a refused Apply reads. Only the refusals the cook can act on are named;
// anything else, such as a malformed request, gets one plain message rather
// than the server's text.
export function applyErrorMessage(err: unknown): string {
  switch (getDomainErrorCode(err)) {
    case 'PLAN_DATE_OVERLAP':
    case 'PLAN_RANGE_TOO_LONG':
      return planErrorMessage(err, APPLY_FAILED);
    case 'SLOT_RECIPE_NOT_PICKABLE':
      return 'A recipe in this plan is no longer available. Swap it, then apply again.';
    case 'SLOT_DINER_NOT_FOUND':
      return 'Someone eating in this plan is no longer in the household. Go back to who’s eating, then apply again.';
    default:
      return APPLY_FAILED;
  }
}
