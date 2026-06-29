import { z } from 'zod';

import { planSlotSchema, slotItemKindSchema, slotTypeSchema } from './plans.ts';

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

// One dish in the desired slot state. `is_base` for `cook_ahead` and the
// household scope of each recipe are checked in the procedure (they need a DB
// read); the schema just shapes the input. `sortOrder` orders dishes within
// the slot.
export const slotItemInputSchema = z.object({
  recipeId: recipeIdSchema,
  servings: servingsSchema,
  kind: slotItemKindSchema,
  sortOrder: z.number().int().nonnegative(),
});
export type SlotItemInput = z.infer<typeof slotItemInputSchema>;

// Full-replace semantics: the caller declares the slot's desired final state —
// status + chef + comment + the complete `items` list. The procedure deletes
// and reinserts the items. Composable occasions (DEC-89): `eat` items are the
// dishes eaten (a main, sides, dessert); `cook_ahead` items are bases produced
// in bulk. The refine encodes the slot-status coupling (`eat` items iff the
// slot is `recipe`); `cook_ahead`-must-be-a-base is enforced in the procedure.
export const updateSlotInputSchema = z
  .object({
    slotId: slotIdSchema,
    slotType: slotTypeSchema,
    chefUserId: z.string().min(1).nullable(),
    comment: slotCommentSchema.nullable(),
    items: z.array(slotItemInputSchema),
  })
  .refine(
    (value) => {
      const hasEat = value.items.some((item) => item.kind === 'eat');
      return value.slotType === 'recipe' ? hasEat : !hasEat;
    },
    {
      path: ['items'],
      message:
        'eat items are required when slotType is recipe, and not allowed otherwise',
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
