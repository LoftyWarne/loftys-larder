import { z } from 'zod';

import { planSlotSchema, slotTypeSchema } from './plans.ts';

const slotIdSchema = z.number().int().positive();
const recipeIdSchema = z.number().int().positive();
const servingsSchema = z.number().int().positive();

export const SLOT_COMMENT_MAX_LENGTH = 2000;

const slotCommentSchema = z
  .string()
  .trim()
  .min(1, 'Comment cannot be empty')
  .max(
    SLOT_COMMENT_MAX_LENGTH,
    `Comment must be ${String(SLOT_COMMENT_MAX_LENGTH)} characters or fewer`,
  );

// Full-replace semantics: every editable field on the slot is in the input,
// and the caller declares the desired final state. The two refines encode the
// biconditional already enforced in the DB CHECK constraints so the procedure
// returns a clean domain error before the write hits the wire. Base-cook
// fields (`cooksBaseRecipeId`, `cooksBaseServings`) land in FEAT-32 and are
// deliberately absent here.
export const updateSlotInputSchema = z
  .object({
    slotId: slotIdSchema,
    slotType: slotTypeSchema,
    recipeId: recipeIdSchema.nullable(),
    numberOfServings: servingsSchema.nullable(),
    chefUserId: z.string().min(1).nullable(),
    comment: slotCommentSchema.nullable(),
  })
  .refine(
    (value) =>
      value.slotType === 'recipe'
        ? value.recipeId !== null
        : value.recipeId === null,
    {
      path: ['recipeId'],
      message:
        'recipeId must be set when slotType is recipe, and null otherwise',
    },
  )
  .refine(
    (value) =>
      value.slotType === 'recipe'
        ? value.numberOfServings !== null
        : value.numberOfServings === null,
    {
      path: ['numberOfServings'],
      message:
        'numberOfServings must be set when slotType is recipe, and null otherwise',
    },
  );
export type UpdateSlotInput = z.infer<typeof updateSlotInputSchema>;

export const updateSlotResultSchema = z.object({
  slot: planSlotSchema,
});
export type UpdateSlotResult = z.infer<typeof updateSlotResultSchema>;
