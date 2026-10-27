import { z } from 'zod';

import {
  healthScoreAverageSchema,
  healthScoreRecipeKindSchema,
} from './health-scores.ts';
import { leftoversSourceSchema, planSchema, slotTypeSchema } from './plans.ts';
import { slotItemInputSchema, withSlotContentRules } from './slots.ts';

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

// What `propose` returns: the Plan Proposal, with each dish's recipe fields
// for Plan Review to show, as a planner slot item carries them. On "Another
// go" the client sends it back as `previous`, which keeps only the proposal's
// own fields.
export const proposedDishSchema = planProposalItemSchema.extend({
  recipeName: z.string(),
  recipeImageUrl: z.string().nullable(),
  isBase: z.boolean(),
  baseRecipeId: recipeIdSchema.nullable(),
});

export type ProposedDish = z.infer<typeof proposedDishSchema>;

export const proposedSlotSchema = planProposalSlotSchema.extend({
  items: z.array(proposedDishSchema),
});

export type ProposedSlot = z.infer<typeof proposedSlotSchema>;

export const proposePlanResultSchema = planProposalSchema.extend({
  slots: z.array(proposedSlotSchema),
});

export type ProposePlanResult = z.infer<typeof proposePlanResultSchema>;

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

// The wizard's Brief step and Plan Review's "Another go" (DEC-49: plain text).
export const planBriefFormSchema = z.object({
  brief: z
    .string()
    .max(
      MEAL_PLAN_BRIEF_MAX_LENGTH,
      `Keep the brief to ${String(MEAL_PLAN_BRIEF_MAX_LENGTH)} characters`,
    ),
});

export type PlanBriefForm = z.infer<typeof planBriefFormSchema>;

export const anotherGoFormSchema = z.object({
  note: z
    .string()
    .max(
      MEAL_PLAN_NOTE_MAX_LENGTH,
      `Keep the note to ${String(MEAL_PLAN_NOTE_MAX_LENGTH)} characters`,
    ),
});

export type AnotherGoForm = z.infer<typeof anotherGoFormSchema>;

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

// Apply (DEC-117): the new plan with every slot as the cook left it in Plan
// Review. One entry per (date × occasion) in the range, each following the
// slot editor's content rules.
export const applyPlanSlotSchema = withSlotContentRules(
  z.object({
    date: civilDateSchema,
    occasionId: occasionIdSchema,
    slotType: slotTypeSchema,
    leftoversSource: leftoversSourceSchema.nullable(),
    items: z.array(slotItemInputSchema),
    dinerUserIds: z.array(z.string().min(1)),
    guestCount: z.number().int().nonnegative(),
  }),
);

export type ApplyPlanSlot = z.infer<typeof applyPlanSlotSchema>;

// Counts from the review, logged as metadata only and never stored, so
// "cooks discard most of a proposal" can be seen (DEC-117's revisit trigger).
export const planReviewCountsSchema = z.object({
  suggested: z.number().int().nonnegative(),
  swapped: z.number().int().nonnegative(),
  discarded: z.number().int().nonnegative(),
  suggestedAgain: z.number().int().nonnegative(),
  anotherGo: z.number().int().nonnegative(),
});

export type PlanReviewCounts = z.infer<typeof planReviewCountsSchema>;

export const createPlanWithSlotsInputSchema = z
  .object({
    startDate: civilDateSchema,
    endDate: civilDateSchema,
    slots: z.array(applyPlanSlotSchema),
    reviewCounts: planReviewCountsSchema.nullable(),
  })
  .refine((value) => value.startDate <= value.endDate, {
    path: ['endDate'],
    message: 'End date must be on or after start date',
  });

export type CreatePlanWithSlotsInput = z.infer<
  typeof createPlanWithSlotsInputSchema
>;

export const createPlanWithSlotsResultSchema = z.object({
  plan: planSchema,
});

export type CreatePlanWithSlotsResult = z.infer<
  typeof createPlanWithSlotsResultSchema
>;

// Plan Review's figures, worked out by rule over the proposal as it stands
// (DEC-110 rule 3): every eaten dish with its date.
export const PROPOSED_FIGURES_MAX_DISHES = 500;

export const proposedFiguresInputSchema = z.object({
  dishes: z
    .array(
      z.object({
        date: civilDateSchema,
        recipeId: recipeIdSchema,
        eaten: z.number().int().positive(),
      }),
    )
    .max(PROPOSED_FIGURES_MAX_DISHES),
});

export type ProposedFiguresInput = z.infer<typeof proposedFiguresInputSchema>;

const proposedFiguresSchema = z.object({
  plantPoints: z.number().int().nonnegative(),
  healthScore: healthScoreAverageSchema,
});

// `days` holds the dates with an eaten dish, in date order.
export const proposedFiguresResultSchema = z.object({
  days: z.array(proposedFiguresSchema.extend({ date: civilDateSchema })),
  plan: proposedFiguresSchema,
});

export type ProposedFiguresResult = z.infer<typeof proposedFiguresResultSchema>;
