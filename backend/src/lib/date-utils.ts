// Centralised "today"-relative semantics for the planner (DEC-33, cross-cutting
// #8). The single hardcoded timezone is Europe/London; every consumer of "today"
// — plan overlap, plan-status filter (FEAT-27), shelf-life (FEAT-37), per-day
// plant points (FEAT-41) — flows through here. Domain code must never reach for
// `new Date()` directly; if a new caller needs a fresh Date for any reason it
// should request it via a helper added here.
//
// Encoding: a *civil day* (a calendar date with no time component) is
// represented as a `Date` at UTC midnight whose UTC year/month/day match the
// Europe/London civil-day parts. PostgreSQL's `date` type round-trips this
// shape losslessly via Drizzle's `mode: 'date'`, so the same `Date` value
// returned by `todayInLondon()` can be compared directly against `start_date`
// / `end_date` columns.

const LONDON_PARTS_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface CivilDateParts {
  year: number;
  month: number;
  day: number;
}

function londonPartsOf(instant: Date): CivilDateParts {
  const parts = LONDON_PARTS_FORMATTER.formatToParts(instant);
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  return { year, month, day };
}

function civilDateAt({ year, month, day }: CivilDateParts): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

// Returns the current civil day in Europe/London as a UTC-midnight `Date`.
// Compare directly against `meal_plans.start_date` / `end_date`.
export function todayInLondon(now: Date = new Date()): Date {
  return civilDateAt(londonPartsOf(now));
}

// Inclusive day-by-day expansion of a civil-day range. Used by slot generation
// (FEAT-27) and downstream FEATs that need to walk a plan's dates. Throws on
// inverted ranges so the caller can catch mis-ordered inputs early.
export function eachDateInRange(start: Date, end: Date): Date[] {
  const startUtc = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const endUtc = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );
  if (endUtc < startUtc) {
    throw new Error('eachDateInRange: end date precedes start date');
  }
  const dates: Date[] = [];
  const ONE_DAY_MS = 86_400_000;
  for (let ts = startUtc; ts <= endUtc; ts += ONE_DAY_MS) {
    dates.push(new Date(ts));
  }
  return dates;
}

// Shift a civil-day Date by a whole number of days. Negative values shift
// backwards. Used by plan duplication (FEAT-29) to anchor a new plan's end
// date and shift slot dates by the start-to-start offset without reaching
// for raw Date arithmetic in domain code (DEC-33).
export function addDays(date: Date, days: number): Date {
  return civilDateAt({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate() + days,
  });
}

// Whole calendar days between two civil-day Dates, inclusive. `daysBetween(d, d)`
// is 1. The plan overlap check uses this to enforce the max-range cap.
export function daysBetween(start: Date, end: Date): number {
  const startUtc = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const endUtc = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );
  return Math.round((endUtc - startUtc) / 86_400_000) + 1;
}

// Parse a `YYYY-MM-DD` string into the civil-day Date encoding. Inputs to the
// plans router come over the wire as ISO date strings; this is the single
// boundary conversion.
export function parseCivilDate(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    throw new Error(`parseCivilDate: not a YYYY-MM-DD string: ${iso}`);
  }
  return civilDateAt({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  });
}

// Format a civil-day Date as `YYYY-MM-DD`. Outbound boundary conversion for
// procedures that return dates to the client (which serialises Date to an ISO
// string by default — `YYYY-MM-DD` is the contract every consumer expects).
export function formatCivilDate(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
