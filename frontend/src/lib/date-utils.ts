// Civil-day helpers for the planner UI (FEAT-31). Mirrors the
// backend/src/lib/date-utils.ts contract: a "civil day" is a calendar date
// with no time component. Cross-workspace runtime imports from /backend are
// forbidden (DEC-80), so this module parallels the backend's semantics
// instead of importing them.
//
// All wire dates flow as YYYY-MM-DD strings, so the planner stays in
// string-space wherever possible. The one operation that needs an actual
// Date is walking a range — done via UTC arithmetic to avoid London
// DST surprises (Date.UTC ignores TZ).

const CIVIL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const LONDON_PARTS_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function parseCivilDate(iso: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = CIVIL_DATE_PATTERN.exec(iso);
  if (!match) {
    throw new Error(`parseCivilDate: not a YYYY-MM-DD string: ${iso}`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function formatCivilDate(parts: {
  year: number;
  month: number;
  day: number;
}): string {
  const y = String(parts.year).padStart(4, '0');
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Returns today's civil day in Europe/London as a YYYY-MM-DD string. Wraps
// the one tolerated `new Date()` so domain code stays free of it (DEC-33).
export function todayInLondon(now: Date = new Date()): string {
  const parts = LONDON_PARTS_FORMATTER.formatToParts(now);
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  return formatCivilDate({ year, month, day });
}

// Inclusive day-by-day expansion of a YYYY-MM-DD range. Throws on inverted
// ranges to match the backend's contract.
export function eachDateInRange(start: string, end: string): string[] {
  const s = parseCivilDate(start);
  const e = parseCivilDate(end);
  const startUtc = Date.UTC(s.year, s.month - 1, s.day);
  const endUtc = Date.UTC(e.year, e.month - 1, e.day);
  if (endUtc < startUtc) {
    throw new Error('eachDateInRange: end date precedes start date');
  }
  const dates: string[] = [];
  const ONE_DAY_MS = 86_400_000;
  for (let ts = startUtc; ts <= endUtc; ts += ONE_DAY_MS) {
    const d = new Date(ts);
    dates.push(
      formatCivilDate({
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
      }),
    );
  }
  return dates;
}

// Clamp a [start, end] visible range to the plan's own range. If either edge
// is omitted, falls back to the plan boundary. Returns null when the clamped
// window collapses to nothing.
export function clampRange(
  planStart: string,
  planEnd: string,
  visibleStart?: string,
  visibleEnd?: string,
): { start: string; end: string } | null {
  const start =
    visibleStart && visibleStart > planStart ? visibleStart : planStart;
  const end = visibleEnd && visibleEnd < planEnd ? visibleEnd : planEnd;
  if (start > end) return null;
  return { start, end };
}

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'short',
  day: '2-digit',
  month: 'short',
});

// Human-friendly day label for grid headers — "Mon 15 Jun".
export function formatDayLabel(iso: string): string {
  const { year, month, day } = parseCivilDate(iso);
  const instant = new Date(Date.UTC(year, month - 1, day));
  return WEEKDAY_FORMATTER.format(instant);
}
