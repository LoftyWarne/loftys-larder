import {
  MEAL_PLAN_BATCH_MAX_PORTIONS,
  MEAL_PLAN_REASON_MAX_LENGTH,
  MEAL_PLAN_SUMMARY_MAX_LENGTH,
  compareSlotOrder,
  mealPlanCandidateSchema,
  mealPlanSlotCandidateSchema,
  type FixedMeal,
  type MealPlanCandidate,
  type PlanProposal,
  type PlanProposalSlot,
} from '../../../../shared/src/index.ts';
import { stripMarkdown } from '../model-features/plain-text.ts';

// The one gate every planner's output passes before the cook sees it,
// whichever adapter produced it (DEC-117). Model output is untrusted:
//   - only slots that aren't fixed are returned, so a Fixed meal can't change;
//   - each slot with someone eating gets exactly one pickable recipe from the
//     household, eaten by its headcount, or is emptied and counted in
//     `dropped`. A "cook" dish cooks at least the headcount; a "leftovers"
//     dish (`plan_meal`, DEC-90) eats a recipe cooked at an earlier slot;
//   - a slot nobody eats at may cook a Batch for later (prepared-only,
//     DEC-91). Anything else there is ignored and the slot stays empty;
//   - text is stripped of markdown (DEC-49) and cut at a word when too long.
//     Unlike a Health Score's, reasons and the summary are never stored, so a
//     long one isn't worth a rerun.
// Quantities are checked by rule after this (DEC-110 rule 3): a Batch not
// used up, or a dish eaten before enough was cooked, shows as a warning in
// review, never as a failure here.
// Null means "try again": the reply wasn't a candidate, or every slot that
// needed a dish was dropped.

export interface ProposalSlotContext {
  date: string;
  occasionId: number;
  // As sent to the planner, which names slots by it.
  occasion: string;
  headcount: number;
  fixed: FixedMeal | null;
}

export interface ProposalContext {
  slots: ProposalSlotContext[];
  pickableRecipeIds: ReadonlySet<number>;
}

type CandidateEntry = MealPlanCandidate['slots'][number];

export function normalisePlanProposal(
  candidate: unknown,
  context: ProposalContext,
): PlanProposal | null {
  const parsed = mealPlanCandidateSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const summary = cutAtWord(
    stripMarkdown(parsed.data.summary),
    MEAL_PLAN_SUMMARY_MAX_LENGTH,
  );

  // The first entry for a slot wins.
  const entries = new Map<string, CandidateEntry>();
  for (const entry of parsed.data.slots) {
    const key = slotKey(entry.date, entry.occasion);
    if (!entries.has(key)) entries.set(key, entry);
  }

  // Walked in the consumption walk's order (DEC-88), so a leftovers dish can
  // only eat what a strictly earlier slot cooked.
  const walk = walkOrder(context.slots);
  const cookedEarlier = new Set<number>();
  const normalised = new Map<number, PlanProposalSlot>();
  let dropped = 0;
  let needed = 0;
  for (const { slot, index } of walk) {
    if (slot.fixed !== null) {
      const cooked = fixedRecipeCooked(slot);
      if (cooked !== null) cookedEarlier.add(cooked);
      continue;
    }
    const entry = entries.get(slotKey(slot.date, slot.occasion));
    if (slot.headcount > 0) needed += 1;
    const result =
      entry && context.pickableRecipeIds.has(entry.recipeId)
        ? normaliseEntry(slot, entry, cookedEarlier)
        : null;
    if (result) {
      normalised.set(index, result);
      for (const item of result.items) {
        if (item.prepared > 0) cookedEarlier.add(item.recipeId);
      }
    } else {
      // A slot nobody eats at needed nothing, so it isn't counted.
      if (slot.headcount > 0) dropped += 1;
      normalised.set(index, emptySlot(slot));
    }
  }

  if (needed > 0 && dropped === needed) return null;
  const slots = context.slots.flatMap((slot, index) => {
    const result = normalised.get(index);
    return result ? [result] : [];
  });
  return { slots, summary, dropped };
}

export interface SlotSuggestionContext {
  // The slot to suggest for, which isn't fixed.
  slot: ProposalSlotContext;
  // Every recipe cooked at a strictly earlier slot: a Fixed meal's, or one
  // the review holds as it stands.
  cookedEarlier: ReadonlySet<number>;
  pickableRecipeIds: ReadonlySet<number>;
  // The recipes already suggested for the slot in this review.
  avoidRecipeIds: ReadonlySet<number>;
}

// Suggest again for one slot, by the same rules as a whole plan's slot. A
// recipe already suggested there is refused while the library has any other
// pickable recipe. Null means "try again": only a slot nobody eats at may come
// back empty, and only when the planner said so.
export function normaliseSlotSuggestion(
  candidate: unknown,
  context: SlotSuggestionContext,
): PlanProposalSlot | null {
  const parsed = mealPlanSlotCandidateSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const { slot } = context;
  const dish = parsed.data.dish;
  if (dish === null) return slot.headcount === 0 ? emptySlot(slot) : null;
  if (!context.pickableRecipeIds.has(dish.recipeId)) return null;
  if (
    context.avoidRecipeIds.has(dish.recipeId) &&
    [...context.pickableRecipeIds].some((id) => !context.avoidRecipeIds.has(id))
  ) {
    return null;
  }
  return normaliseEntry(
    slot,
    { ...dish, date: slot.date, occasion: slot.occasion },
    context.cookedEarlier,
  );
}

// The recipes cooked before `target` in the consumption walk's order: each
// Fixed meal's, and each dish prepared in `current`, the review's slots that
// aren't fixed. An entry in `current` for a fixed slot is ignored.
export function cookedBefore(
  target: Pick<ProposalSlotContext, 'date' | 'occasion'>,
  slots: readonly ProposalSlotContext[],
  current: readonly Pick<PlanProposalSlot, 'date' | 'occasionId' | 'items'>[],
): Set<number> {
  const byKey = new Map(
    current.map((entry) => [
      `${entry.date}|${entry.occasionId.toString()}`,
      entry,
    ]),
  );
  const cooked = new Set<number>();
  for (const slot of slots) {
    const earlier =
      compareSlotOrder(
        { date: slot.date, occasionName: slot.occasion },
        { date: target.date, occasionName: target.occasion },
      ) < 0;
    if (!earlier) continue;
    if (slot.fixed !== null) {
      const fixed = fixedRecipeCooked(slot);
      if (fixed !== null) cooked.add(fixed);
      continue;
    }
    const entry = byKey.get(`${slot.date}|${slot.occasionId.toString()}`);
    for (const item of entry?.items ?? []) {
      if (item.prepared > 0) cooked.add(item.recipeId);
    }
  }
  return cooked;
}

function walkOrder(
  slots: readonly ProposalSlotContext[],
): { slot: ProposalSlotContext; index: number }[] {
  return slots
    .map((slot, index) => ({ slot, index }))
    .sort(
      (a, b) =>
        compareSlotOrder(
          { date: a.slot.date, occasionName: a.slot.occasion },
          { date: b.slot.date, occasionName: b.slot.occasion },
        ) || a.index - b.index,
    );
}

// The recipe a Fixed meal cooks, if any.
function fixedRecipeCooked(slot: ProposalSlotContext): number | null {
  const fixed = slot.fixed;
  if (fixed?.kind === 'batch') return fixed.recipeId;
  if (fixed?.kind === 'recipe' && slot.headcount > 0) return fixed.recipeId;
  return null;
}

function normaliseEntry(
  slot: ProposalSlotContext,
  entry: CandidateEntry,
  cookedEarlier: ReadonlySet<number>,
): PlanProposalSlot | null {
  const reasonText = cutAtWord(
    stripMarkdown(entry.reason),
    MEAL_PLAN_REASON_MAX_LENGTH,
  );
  const reason = reasonText === '' ? null : reasonText;
  const base = {
    date: slot.date,
    occasionId: slot.occasionId,
    reason,
  };
  const { headcount } = slot;
  if (entry.kind === 'leftovers') {
    if (headcount === 0 || !cookedEarlier.has(entry.recipeId)) return null;
    return {
      ...base,
      slotType: 'leftovers',
      leftoversSource: 'plan_meal',
      items: [{ recipeId: entry.recipeId, prepared: 0, eaten: headcount }],
    };
  }
  const prepared = entry.prepared;
  const cap = Math.max(MEAL_PLAN_BATCH_MAX_PORTIONS, headcount);
  if (
    !Number.isInteger(prepared) ||
    prepared < Math.max(headcount, 1) ||
    prepared > cap
  ) {
    return null;
  }
  return {
    ...base,
    slotType: headcount === 0 ? 'empty' : 'recipe',
    leftoversSource: null,
    items: [{ recipeId: entry.recipeId, prepared, eaten: headcount }],
  };
}

export function emptySlot(
  slot: Pick<ProposalSlotContext, 'date' | 'occasionId'>,
): PlanProposalSlot {
  return {
    date: slot.date,
    occasionId: slot.occasionId,
    slotType: 'empty',
    leftoversSource: null,
    items: [],
    reason: null,
  };
}

// Text over `max` ends at the last word that fits, with an ellipsis, all
// within `max`. A single word longer than that is cut mid-word.
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  // A word that ends exactly at the cut is whole, so it stays.
  const lastSpace = /\s/.test(text.charAt(max - 1))
    ? room.length
    : room.search(/\s\S*$/);
  const kept = lastSpace > 0 ? room.slice(0, lastSpace) : room;
  return `${kept.trimEnd()}…`;
}

// Occasions are matched as the model writes them back, ignoring case and
// surrounding space.
function slotKey(date: string, occasion: string): string {
  return `${date.trim()}|${occasion.trim().toLowerCase()}`;
}
