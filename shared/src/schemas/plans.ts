import { z } from 'zod';

// Plan DTOs for the create/list/get/delete procedures. All dates flow over the
// wire as `YYYY-MM-DD` strings (no time component); the project doesn't run a
// tRPC data transformer, so a JS Date would serialise to an ISO timestamp that
// loses the civil-day intent. The backend converts at the boundary using
// `parseCivilDate` / `formatCivilDate` from `date-utils`.

const planIdSchema = z.number().int().positive();
const slotIdSchema = z.number().int().positive();
const occasionIdSchema = z.number().int().positive();
const recipeIdSchema = z.number().int().positive();

const civilDateSchema = z.iso.date();

export const PLAN_NAME_MAX_LENGTH = 120;
export const PLAN_MAX_RANGE_DAYS = 14;

export const planNameSchema = z
  .string()
  .trim()
  .min(1, 'Plan name is required')
  .max(PLAN_NAME_MAX_LENGTH);

export const planStatusSchema = z.enum(['active', 'past', 'future', 'all']);
export type PlanStatus = z.infer<typeof planStatusSchema>;

// Slot states mirror the Postgres `slot_type` enum (DEC-25). Strings are kept
// as-is across the wire; the planner UI maps them to icons/labels.
export const slotTypeSchema = z.enum([
  'empty',
  'recipe',
  'eat_out',
  'takeaway',
  'leftovers',
]);
export type SlotType = z.infer<typeof slotTypeSchema>;

// Minimal recipe sub-shape attached to assigned slots. Includes `isDeleted` so
// the planner UI can render a "(deleted)" hint on historical slots whose
// recipe was soft-deleted after assignment (DEC-21).
export const planSlotRecipeSchema = z.object({
  id: recipeIdSchema,
  name: z.string(),
  imageUrl: z.string().nullable(),
  isBase: z.boolean(),
  isDeleted: z.boolean(),
});
export type PlanSlotRecipe = z.infer<typeof planSlotRecipeSchema>;

export const planSlotSchema = z.object({
  id: slotIdSchema,
  planId: planIdSchema,
  date: civilDateSchema,
  occasionId: occasionIdSchema,
  occasionName: z.string(),
  slotType: slotTypeSchema,
  recipeId: recipeIdSchema.nullable(),
  numberOfServings: z.number().int().positive().nullable(),
  chefUserId: z.string().nullable(),
  cooksBaseRecipeId: recipeIdSchema.nullable(),
  cooksBaseServings: z.number().int().positive().nullable(),
  recipe: planSlotRecipeSchema.nullable(),
});
export type PlanSlot = z.infer<typeof planSlotSchema>;

export const planSchema = z.object({
  id: planIdSchema,
  name: z.string(),
  startDate: civilDateSchema,
  endDate: civilDateSchema,
  createdByUserId: z.string().nullable(),
});
export type Plan = z.infer<typeof planSchema>;

export const createPlanInputSchema = z
  .object({
    name: planNameSchema,
    startDate: civilDateSchema,
    endDate: civilDateSchema,
  })
  .refine((value) => value.startDate <= value.endDate, {
    path: ['endDate'],
    message: 'End date must be on or after start date',
  });
export type CreatePlanInput = z.infer<typeof createPlanInputSchema>;

export const createPlanResultSchema = z.object({
  plan: planSchema,
  slotCount: z.number().int().nonnegative(),
});
export type CreatePlanResult = z.infer<typeof createPlanResultSchema>;

export const listPlansInputSchema = z.object({
  status: planStatusSchema,
});
export type ListPlansInput = z.infer<typeof listPlansInputSchema>;

export const listPlansResultSchema = z.object({
  items: z.array(planSchema),
});
export type ListPlansResult = z.infer<typeof listPlansResultSchema>;

export const getPlanInputSchema = z.object({
  id: planIdSchema,
});
export type GetPlanInput = z.infer<typeof getPlanInputSchema>;

export const getPlanResultSchema = planSchema.extend({
  slots: z.array(planSlotSchema),
});
export type GetPlanResult = z.infer<typeof getPlanResultSchema>;

export const deletePlanInputSchema = z.object({
  id: planIdSchema,
});
export type DeletePlanInput = z.infer<typeof deletePlanInputSchema>;

export const deletePlanResultSchema = z.object({
  id: planIdSchema,
});
export type DeletePlanResult = z.infer<typeof deletePlanResultSchema>;
