import {
  MEAL_PLAN_REASON_MAX_LENGTH,
  MEAL_PLAN_SUMMARY_MAX_LENGTH,
  mealPlanCandidateSchema,
  type FixedMeal,
  type PlanProposal,
  type PlanProposalSlot,
} from '../../../../shared/src/index.ts';
import { stripMarkdown } from '../model-features/plain-text.ts';

// The one gate every planner's output passes before the cook sees it,
// whichever adapter produced it (DEC-117). Model output is untrusted:
//   - only slots that aren't fixed are returned, so a Fixed meal can't change;
//   - a slot nobody eats at stays empty;
//   - each other slot gets exactly one pickable recipe from the household,
//     eaten by its headcount, or is emptied and counted in `dropped`;
//   - text is stripped of markdown (DEC-49) and cut at a word when too long.
//     Unlike a Health Score's, reasons and the summary are never stored, so a
//     long one isn't worth a rerun.
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
  const entries = new Map<string, (typeof parsed.data.slots)[number]>();
  for (const entry of parsed.data.slots) {
    const key = slotKey(entry.date, entry.occasion);
    if (!entries.has(key)) entries.set(key, entry);
  }

  let dropped = 0;
  let needed = 0;
  const slots = context.slots
    .filter((slot) => slot.fixed === null)
    .map((slot): PlanProposalSlot => {
      if (slot.headcount === 0) return emptySlot(slot);
      needed += 1;
      const entry = entries.get(slotKey(slot.date, slot.occasion));
      if (!entry || !context.pickableRecipeIds.has(entry.recipeId)) {
        dropped += 1;
        return emptySlot(slot);
      }
      const reason = cutAtWord(
        stripMarkdown(entry.reason),
        MEAL_PLAN_REASON_MAX_LENGTH,
      );
      return {
        date: slot.date,
        occasionId: slot.occasionId,
        slotType: 'recipe',
        leftoversSource: null,
        items: [
          {
            recipeId: entry.recipeId,
            prepared: slot.headcount,
            eaten: slot.headcount,
          },
        ],
        reason: reason === '' ? null : reason,
      };
    });

  if (needed > 0 && dropped === needed) return null;
  return { slots, summary, dropped };
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
