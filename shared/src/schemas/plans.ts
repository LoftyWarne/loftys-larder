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

export const PLAN_MAX_RANGE_DAYS = 14;

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

// What a `leftovers` slot is eating (mirrors the Postgres `leftovers_source`
// enum). `plan_meal` carries the eaten dish as the slot's single `eat` item
// (FK to the recipe); `takeaway` / `other` are bare markers. Present iff the
// slot is `leftovers`.
export const leftoversSourceSchema = z.enum(['plan_meal', 'takeaway', 'other']);
export type LeftoversSource = z.infer<typeof leftoversSourceSchema>;

// Slot item with the recipe fields denormalised for rendering (name/image,
// plus `isBase`/`baseRecipeId` for the consumption balance and `isDeleted` for
// the "(deleted)" hint on historical slots — DEC-21). `prepared` = portions
// cooked, `eaten` = portions consumed here (DEC-91); role (produce/consume) is
// derived from the two, not stored.
export const planSlotItemSchema = z.object({
  id: z.number().int().positive(),
  recipeId: recipeIdSchema,
  recipeName: z.string(),
  recipeImageUrl: z.string().nullable(),
  isBase: z.boolean(),
  baseRecipeId: recipeIdSchema.nullable(),
  isDeleted: z.boolean(),
  prepared: z.number().int().nonnegative(),
  eaten: z.number().int().nonnegative(),
  sortOrder: z.number().int().nonnegative(),
});
export type PlanSlotItem = z.infer<typeof planSlotItemSchema>;

export const planSlotSchema = z.object({
  id: slotIdSchema,
  planId: planIdSchema,
  date: civilDateSchema,
  occasionId: occasionIdSchema,
  occasionName: z.string(),
  slotType: slotTypeSchema,
  // Set only on `leftovers` slots; `null` otherwise. `plan_meal` slots also
  // carry the eaten dish in `items` (one `eat` row).
  leftoversSource: leftoversSourceSchema.nullable(),
  chefUserId: z.string().nullable(),
  comment: z.string().nullable(),
  items: z.array(planSlotItemSchema),
  // Who's eating: the household members present plus a guest count for diners
  // with no account (kids, guests). Headcount = dinerUserIds.length + guestCount,
  // derived in the UI, never stored.
  dinerUserIds: z.array(z.string()),
  guestCount: z.number().int().nonnegative(),
});
export type PlanSlot = z.infer<typeof planSlotSchema>;

export const planSchema = z.object({
  id: planIdSchema,
  startDate: civilDateSchema,
  endDate: civilDateSchema,
  createdByUserId: z.string().nullable(),
});
export type Plan = z.infer<typeof planSchema>;

// `list` rows carry a slot-fill summary so the index page renders
// "X / Y slots assigned" without an N+1 follow-up per card. `get` /
// `updateRange` / `duplicate` outputs intentionally don't inherit these
// fields — those callers already have the full slot array.
export const planListItemSchema = planSchema.extend({
  slotsTotal: z.number().int().nonnegative(),
  slotsAssigned: z.number().int().nonnegative(),
});
export type PlanListItem = z.infer<typeof planListItemSchema>;

export const createPlanInputSchema = z
  .object({
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
  items: z.array(planListItemSchema),
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

export const updatePlanRangeInputSchema = z
  .object({
    id: planIdSchema,
    startDate: civilDateSchema,
    endDate: civilDateSchema,
    confirmDestructive: z.boolean().optional(),
  })
  .refine((value) => value.startDate <= value.endDate, {
    path: ['endDate'],
    message: 'End date must be on or after start date',
  });
export type UpdatePlanRangeInput = z.infer<typeof updatePlanRangeInputSchema>;

// Result is structurally identical to getPlanResultSchema — same projection
// pattern (plan dto + slots ordered by date, occasionId).
export const updatePlanRangeResultSchema = planSchema.extend({
  slots: z.array(planSlotSchema),
});
export type UpdatePlanRangeResult = z.infer<typeof updatePlanRangeResultSchema>;

// Duplicate copies a plan's slot assignments into a new plan anchored on
// `newStartDate`. Duration is inherited from the source (so no `endDate` on
// the input); slot dates are shifted by `newStartDate - source.startDate`.
export const duplicatePlanInputSchema = z.object({
  planId: planIdSchema,
  newStartDate: civilDateSchema,
});
export type DuplicatePlanInput = z.infer<typeof duplicatePlanInputSchema>;

export const duplicatePlanResultSchema = z.object({
  plan: planSchema,
  slotCount: z.number().int().nonnegative(),
});
export type DuplicatePlanResult = z.infer<typeof duplicatePlanResultSchema>;

// Shape of the slot list surfaced on PLAN_DESTRUCTIVE_RANGE_CHANGE so the UI
// can render a "these slots will be lost" confirm dialog.
export const planSlotLossSchema = z.object({
  id: slotIdSchema,
  date: civilDateSchema,
  occasionId: occasionIdSchema,
  slotType: slotTypeSchema,
  // How many dishes the slot holds — drives the "these slots will be lost"
  // confirm dialog (a slot is "lost" if it has content: items or a non-empty
  // status).
  itemCount: z.number().int().nonnegative(),
});
export type PlanSlotLoss = z.infer<typeof planSlotLossSchema>;
