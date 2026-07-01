import { z } from 'zod';

import {
  leftoversSourceSchema,
  planSlotSchema,
  slotTypeSchema,
} from './plans.ts';

const slotIdSchema = z.number().int().positive();
const recipeIdSchema = z.number().int().positive();
const quantitySchema = z.number().int().nonnegative();

export const SLOT_COMMENT_MAX_LENGTH = 2000;

const slotCommentSchema = z
  .string()
  .trim()
  .min(1, 'Comment cannot be empty')
  .max(
    SLOT_COMMENT_MAX_LENGTH,
    `Comment must be ${String(SLOT_COMMENT_MAX_LENGTH)} characters or fewer`,
  );

// One dish in the desired slot state (DEC-91). `prepared` = portions cooked,
// `eaten` = portions consumed here; a dish must do at least one (`prepared +
// eaten > 0`). The household scope of each recipe is checked in the procedure
// (it needs a DB read); the schema just shapes the input. `sortOrder` orders
// dishes within the slot.
export const slotItemInputSchema = z
  .object({
    recipeId: recipeIdSchema,
    prepared: quantitySchema,
    eaten: quantitySchema,
    sortOrder: z.number().int().nonnegative(),
  })
  .refine((value) => value.prepared + value.eaten > 0, {
    path: ['prepared'],
    message: 'A dish must have a prepared or eaten quantity',
  });
export type SlotItemInput = z.infer<typeof slotItemInputSchema>;

// Full-replace semantics: the caller declares the slot's desired final state —
// status + chef + comment + the complete `items` list. The procedure deletes
// and reinserts the items. Composable occasions (DEC-89/DEC-91): each item
// carries `prepared` (cooked) + `eaten` (consumed here). The refine encodes the
// slot-status coupling in terms of what's *eaten* (`eaten > 0` items iff the
// slot is `recipe`); prepared-only cook-ahead rows are allowed on any type.
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
    // diners. Attendance is orthogonal to the meal: it persists on every slot
    // type, including `empty` (you can know who's eating before deciding what).
    // Full-replace, like `items`: the caller always declares the complete set.
    // The procedure checks each user id exists in the household.
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
      const eatenCount = value.items.filter((item) => item.eaten > 0).length;
      // A `recipe` slot is the eaten meal: at least one dish is eaten here.
      if (value.slotType === 'recipe') return eatenCount >= 1;
      // `leftovers` of a planned meal: exactly the one eaten dish (pure
      // consume — the food was cooked earlier), no cooking here.
      if (value.slotType === 'leftovers') {
        const only = value.items[0];
        return value.leftoversSource === 'plan_meal'
          ? value.items.length === 1 &&
              only !== undefined &&
              only.eaten > 0 &&
              only.prepared === 0
          : value.items.length === 0;
      }
      // empty / eat_out / takeaway: nothing eaten here (prepared-only
      // cook-ahead rows are still allowed).
      return eatenCount === 0;
    },
    {
      path: ['items'],
      message:
        'eaten items are required when slotType is recipe, are exactly one pure-consume dish for leftovers of a planned meal, and not allowed otherwise',
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
