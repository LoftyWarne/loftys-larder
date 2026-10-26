import { z } from 'zod';

import { healthScoreRecipeKindSchema } from './health-scores.ts';
import { leftoversSourceSchema, slotTypeSchema } from './plans.ts';

// AI meal planning (DEC-117): a model proposes meals for a new plan's slots
// that aren't fixed, and the cook reviews them before anything is written.

const recipeIdSchema = z.number().int().positive();
const occasionIdSchema = z.number().int().positive();
const civilDateSchema = z.iso.date();

export const MEAL_PLAN_BRIEF_MAX_LENGTH = 500;
export const MEAL_PLAN_NOTE_MAX_LENGTH = 200;
export const MEAL_PLAN_REASON_MAX_LENGTH = 120;
export const MEAL_PLAN_SUMMARY_MAX_LENGTH = 300;

// A Fixed meal: the model plans around it and never changes it. `empty` is
// sent only on "Another go", for a slot the cook discarded in review.
export const fixedMealSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recipe'), recipeId: recipeIdSchema }),
  z.object({ kind: z.literal('eat_out') }),
  z.object({ kind: z.literal('takeaway') }),
  z.object({ kind: z.literal('empty') }),
]);

export type FixedMeal = z.infer<typeof fixedMealSchema>;

export const planProposalItemSchema = z.object({
  recipeId: recipeIdSchema,
  prepared: z.number().int().nonnegative(),
  eaten: z.number().int().nonnegative(),
});

export type PlanProposalItem = z.infer<typeof planProposalItemSchema>;

// One unfixed slot. An empty slot has no items and no reason.
export const planProposalSlotSchema = z.object({
  date: civilDateSchema,
  occasionId: occasionIdSchema,
  slotType: slotTypeSchema,
  leftoversSource: leftoversSourceSchema.nullable(),
  items: z.array(planProposalItemSchema),
  reason: z.string().min(1).max(MEAL_PLAN_REASON_MAX_LENGTH).nullable(),
});

export type PlanProposalSlot = z.infer<typeof planProposalSlotSchema>;

// `dropped` counts the slots the normaliser emptied because it couldn't use
// what the model returned for them.
export const planProposalSchema = z.object({
  slots: z.array(planProposalSlotSchema),
  summary: z.string().max(MEAL_PLAN_SUMMARY_MAX_LENGTH),
  dropped: z.number().int().nonnegative(),
});

export type PlanProposal = z.infer<typeof planProposalSchema>;

export const proposePlanSlotSchema = z.object({
  date: civilDateSchema,
  occasionId: occasionIdSchema,
  dinerUserIds: z.array(z.string().min(1)),
  guestCount: z.number().int().nonnegative(),
  fixed: fixedMealSchema.nullable(),
});

export type ProposePlanSlot = z.infer<typeof proposePlanSlotSchema>;

// `slots` holds one entry per (date × occasion) in the range. `note` and
// `previous` are set only on "Another go".
export const proposePlanInputSchema = z
  .object({
    startDate: civilDateSchema,
    endDate: civilDateSchema,
    slots: z.array(proposePlanSlotSchema),
    brief: z.string().trim().max(MEAL_PLAN_BRIEF_MAX_LENGTH).nullable(),
    note: z.string().trim().max(MEAL_PLAN_NOTE_MAX_LENGTH).nullable(),
    previous: planProposalSchema.nullable(),
  })
  .refine((value) => value.startDate <= value.endDate, {
    path: ['endDate'],
    message: 'End date must be on or after start date',
  });

export type ProposePlanInput = z.infer<typeof proposePlanInputSchema>;

export const mealPlanRecipeSchema = z.object({
  id: recipeIdSchema,
  name: z.string(),
  tags: z.array(z.string()),
  kind: healthScoreRecipeKindSchema,
  baseRecipeId: recipeIdSchema.nullable(),
  baseServings: z.number().int().positive(),
  activeMins: z.number().int().nullable(),
  totalMins: z.number().int().nullable(),
  averageRating: z.number().nullable(),
  healthScore: z.number().int().nullable(),
  healthScoreOutOfDate: z.boolean(),
  ingredientNames: z.array(z.string()),
  lastPlannedOn: civilDateSchema.nullable(),
  timesPlannedLast4Weeks: z.number().int().nonnegative(),
});

export type MealPlanRecipe = z.infer<typeof mealPlanRecipeSchema>;

// What the planner is sent, and all it's sent (DEC-117). Headcounts only:
// never who the diners are.
export const mealPlanRequestSchema = z.object({
  slots: z.array(
    z.object({
      date: civilDateSchema,
      occasion: z.string(),
      headcount: z.number().int().nonnegative(),
      fixed: fixedMealSchema.nullable(),
    }),
  ),
  recipes: z.array(mealPlanRecipeSchema),
  brief: z.string().nullable(),
  note: z.string().nullable(),
  previous: z
    .object({
      slots: z.array(
        z.object({
          date: civilDateSchema,
          occasion: z.string(),
          recipeId: recipeIdSchema.nullable(),
        }),
      ),
      summary: z.string(),
    })
    .nullable(),
});

export type MealPlanRequest = z.infer<typeof mealPlanRequestSchema>;

// The planner's reply, kept to what structured outputs can express: no range
// or length limits. `normalisePlanProposal` parses it into a Plan Proposal.
export const mealPlanCandidateSchema = z.object({
  slots: z.array(
    z.object({
      date: z.string().describe('The slot’s date, as YYYY-MM-DD.'),
      occasion: z.string().describe('The slot’s occasion, as sent.'),
      recipeId: z.number().describe('The id of one recipe from the library.'),
      reason: z.string().describe('Why this recipe here, in plain text.'),
    }),
  ),
  summary: z
    .string()
    .describe('The week in brief, and how the Brief was read, in plain text.'),
});

export type MealPlanCandidate = z.infer<typeof mealPlanCandidateSchema>;
