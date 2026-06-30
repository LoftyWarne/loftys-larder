import { z } from 'zod';

import {
  leftoversSourceSchema,
  planSlotSchema,
  slotItemKindSchema,
  slotTypeSchema,
} from './plans.ts';

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
    // Required (and only allowed) when slotType is `leftovers`. `plan_meal`
    // pairs with exactly one `eat` item (the dish being eaten as leftovers);
    // `takeaway` / `other` carry no items.
    leftoversSource: leftoversSourceSchema.nullable(),
    chefUserId: z.string().min(1).nullable(),
    comment: slotCommentSchema.nullable(),
    items: z.array(slotItemInputSchema),
    // Who's eating: named household members + a guest count for accountless
    // diners. Allowed on any slot type that's actually a meal; cleared when the
    // slot goes empty (see the refine below). Full-replace, like `items`: the
    // caller always declares the complete set. The procedure checks each user
    // id exists in the household.
    dinerUserIds: z.array(z.string().min(1)),
    guestCount: z.number().int().nonnegative(),
  })
  .refine(
    (value) =>
      (value.slotType === 'leftovers') === (value.leftoversSource !== null),
    {
      path: ['leftoversSource'],
      message:
        'leftoversSource is required when slotType is leftovers, and not allowed otherwise',
    },
  )
  .refine(
    (value) => {
      const eatCount = value.items.filter((item) => item.kind === 'eat').length;
      // A `recipe` slot is the eaten meal: at least one `eat` dish.
      if (value.slotType === 'recipe') return eatCount >= 1;
      // `leftovers` of a planned meal: exactly the one eaten dish, no cooks.
      if (value.slotType === 'leftovers') {
        return value.leftoversSource === 'plan_meal'
          ? value.items.length === 1 && value.items[0]?.kind === 'eat'
          : value.items.length === 0;
      }
      // empty / eat_out / takeaway: nothing eaten here.
      return eatCount === 0;
    },
    {
      path: ['items'],
      message:
        'eat items are required when slotType is recipe, are exactly one for leftovers of a planned meal, and not allowed otherwise',
    },
  )
  .refine(
    (value) =>
      value.slotType !== 'empty' ||
      (value.dinerUserIds.length === 0 && value.guestCount === 0),
    {
      path: ['dinerUserIds'],
      message: 'an empty slot cannot have diners or guests',
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
