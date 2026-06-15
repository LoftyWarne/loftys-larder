import { z } from 'zod';

// URL search-param schema for the planner view (FEAT-31). Both start and end
// are optional; when omitted, the planner falls back to the plan's own range.
// Encoded as `YYYY-MM-DD` strings — matches the civil-date wire format used
// by every other plan/slot DTO and avoids timezone drift in URLs.
export const plannerSearchSchema = z
  .object({
    start: z.iso.date().optional(),
    end: z.iso.date().optional(),
  })
  .refine(
    (value) =>
      value.start === undefined ||
      value.end === undefined ||
      value.start <= value.end,
    { path: ['end'], message: 'End date must be on or after start date' },
  );
export type PlannerSearch = z.infer<typeof plannerSearchSchema>;
