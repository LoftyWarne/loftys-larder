import { z } from 'zod';

import { planStatusSchema } from './plans.ts';

// URL search-param schema for the plans browse view. Status defaults to
// `active` so the browse view opens on the cook's current plan without an
// extra click. Shareable: the URL fully describes which bucket the user is
// looking at.
export const plansSearchSchema = z.object({
  status: planStatusSchema.optional().default('active'),
});
export type PlansSearch = z.infer<typeof plansSearchSchema>;
