import { getDomainErrorCode } from '@/lib/domain-error.ts';

// Plan creation's messages, shared by the plans page and the planning wizard
// so both refuse a range in the same words.
export function planErrorMessage(err: unknown, fallback: string): string {
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
