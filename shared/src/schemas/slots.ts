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
// and the caller declares the desired final state. The refines encode the
// biconditionals already enforced in the DB CHECK constraints so the
// procedure returns a clean domain error before the write hits the wire. The
// base-cook pair is restricted to `slot_type='recipe'` slots at this layer
// (defence in depth above the unconditional DB joint-set CHECK).
export const updateSlotInputSchema = z
  .object({
    slotId: slotIdSchema,
    slotType: slotTypeSchema,
    recipeId: recipeIdSchema.nullable(),
    numberOfServings: servingsSchema.nullable(),
    chefUserId: z.string().min(1).nullable(),
    cooksBaseRecipeId: recipeIdSchema.nullable(),
    cooksBaseServings: servingsSchema.nullable(),
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
  )
  .refine(
    (value) =>
      (value.cooksBaseRecipeId === null) === (value.cooksBaseServings === null),
    {
      path: ['cooksBaseServings'],
      message:
        'cooksBaseRecipeId and cooksBaseServings must be set together or both null',
    },
  )
  .refine(
    (value) => value.slotType === 'recipe' || value.cooksBaseRecipeId === null,
    {
      path: ['cooksBaseRecipeId'],
      message: 'Base-cook fields are only allowed on recipe slots',
    },
  );
export type UpdateSlotInput = z.infer<typeof updateSlotInputSchema>;

export const updateSlotResultSchema = z.object({
  slot: planSlotSchema,
});
export type UpdateSlotResult = z.infer<typeof updateSlotResultSchema>;

// FEAT-40 desktop / large-tablet drag affordance: source content moves to
// dest. When dest is populated the procedure swaps; when dest is empty the
// source is emptied. Both writes happen inside one `withTransaction` so the
// shared resource sees an atomic state — last-write-wins still applies per
// DEC-36 if two clients race.
export const relocateSlotInputSchema = z
  .object({
    sourceSlotId: slotIdSchema,
    destSlotId: slotIdSchema,
  })
  .refine((value) => value.sourceSlotId !== value.destSlotId, {
    path: ['destSlotId'],
    message: 'sourceSlotId and destSlotId must differ',
  });
export type RelocateSlotInput = z.infer<typeof relocateSlotInputSchema>;

export const relocateSlotResultSchema = z.object({
  sourceSlot: planSlotSchema,
  destSlot: planSlotSchema,
});
export type RelocateSlotResult = z.infer<typeof relocateSlotResultSchema>;
