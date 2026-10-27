import type {
  ApplyPlanSlot,
  CreatePlanWithSlotsInput,
  FixedMeal,
  PlanOccasion,
  PlanReviewCounts,
  PlanSlot,
  PlanSlotItem,
  ProposedFiguresInput,
  ProposedSlot,
  ProposePlanInput,
  ProposePlanResult,
} from '@loftys-larder/shared';

import { eachDateInRange } from '@/lib/date-utils.ts';

// The planning wizard's state, as pure functions over plain data (DEC-117).
// It lives in React state only (DEC-09): nothing is stored before Apply.

export interface Attendance {
  dinerUserIds: readonly string[];
  guestCount: number;
}

// Each level overrides the one before: every slot, then each occasion, then
// each slot.
export interface AttendanceSettings {
  all: Attendance;
  byOccasion: ReadonlyMap<number, Attendance>;
  bySlot: ReadonlyMap<string, Attendance>;
}

// A recipe the cook picked, with what the slot card shows.
export interface RecipeChoice {
  id: number;
  name: string;
  imageUrl: string | null;
  isBase: boolean;
  baseRecipeId: number | null;
}

// Leftovers can't be fixed: the model proposes them.
export type FixedChoice =
  | { kind: 'recipe'; recipe: RecipeChoice }
  | { kind: 'eat_out' }
  | { kind: 'takeaway' };

export interface WizardInputs {
  startDate: string;
  endDate: string;
  occasions: readonly PlanOccasion[];
  attendance: AttendanceSettings;
  fixed: ReadonlyMap<string, FixedChoice>;
  brief: string;
}

export interface WizardSlotRef {
  key: string;
  date: string;
  occasionId: number;
  occasionName: string;
}

// Every suggestion counts as kept unless the cook swaps or discards it.
export type ReviewSlotStatus =
  | { kind: 'suggested' }
  | { kind: 'swapped'; recipe: RecipeChoice }
  | { kind: 'discarded' };

export interface ReviewSlot {
  // The latest suggestion for the slot, which restore puts back.
  suggestion: ProposedSlot;
  status: ReviewSlotStatus;
}

export interface ReviewState {
  slots: ReadonlyMap<string, ReviewSlot>;
  summary: string;
  dropped: number;
  // The proposal as the model last made it, sent back on "Another go".
  proposal: ProposePlanResult;
  anotherGoCount: number;
}

export type ReviewSlotKind =
  | 'fixed'
  | 'suggested'
  | 'swapped'
  | 'discarded'
  | 'unfilled';

export interface ReviewPlanSlot {
  slot: PlanSlot;
  kind: ReviewSlotKind;
  reason: string | null;
  // Swap is offered on any slot that isn't fixed and has someone eating.
  canSwap: boolean;
}

export function slotKey(date: string, occasionId: number): string {
  return `${date}|${String(occasionId)}`;
}

export function wizardSlots(
  startDate: string,
  endDate: string,
  occasions: readonly PlanOccasion[],
): WizardSlotRef[] {
  return eachDateInRange(startDate, endDate).flatMap((date) =>
    occasions.map((occasion) => ({
      key: slotKey(date, occasion.id),
      date,
      occasionId: occasion.id,
      occasionName: occasion.name,
    })),
  );
}

export function groupByDate(
  slots: readonly WizardSlotRef[],
): [string, WizardSlotRef[]][] {
  const byDate = new Map<string, WizardSlotRef[]>();
  for (const slot of slots) {
    const list = byDate.get(slot.date);
    if (list) list.push(slot);
    else byDate.set(slot.date, [slot]);
  }
  return [...byDate];
}

export function defaultAttendance(
  memberIds: readonly string[],
): AttendanceSettings {
  return {
    all: { dinerUserIds: [...memberIds], guestCount: 0 },
    byOccasion: new Map(),
    bySlot: new Map(),
  };
}

export function resolveAttendance(
  settings: AttendanceSettings,
  date: string,
  occasionId: number,
): Attendance {
  return (
    settings.bySlot.get(slotKey(date, occasionId)) ??
    settings.byOccasion.get(occasionId) ??
    settings.all
  );
}

// Diners plus guests, as on the planner.
export function headcount(attendance: Attendance): number {
  return attendance.dinerUserIds.length + attendance.guestCount;
}

export const NOBODY_EATING: Attendance = { dinerUserIds: [], guestCount: 0 };

// A recipe can't be fixed where nobody eats: it would be neither prepared nor
// eaten. Batches cooked for later arrive with batch cooking.
export function canFixRecipe(attendance: Attendance): boolean {
  return headcount(attendance) > 0;
}

// Keeps the Fixed meals the plan can still hold, after a change to the dates
// or attendance: those in the range, and a recipe only where someone eats.
// Returns the same map when nothing changed.
export function pruneFixedMeals(
  inputs: Pick<WizardInputs, 'attendance' | 'fixed'>,
  slots: readonly WizardSlotRef[],
): ReadonlyMap<string, FixedChoice> {
  const next = new Map<string, FixedChoice>();
  for (const slot of slots) {
    const choice = inputs.fixed.get(slot.key);
    if (!choice) continue;
    const attendance = resolveAttendance(
      inputs.attendance,
      slot.date,
      slot.occasionId,
    );
    if (choice.kind === 'recipe' && !canFixRecipe(attendance)) continue;
    next.set(slot.key, choice);
  }
  return next.size === inputs.fixed.size ? inputs.fixed : next;
}

// What a proposal was made from. Continuing after any of it changed needs a
// new proposal.
export function inputsSignature(inputs: WizardInputs): string {
  const slots = wizardSlots(inputs.startDate, inputs.endDate, inputs.occasions);
  return JSON.stringify({
    startDate: inputs.startDate,
    endDate: inputs.endDate,
    slots: slots.map((slot) => {
      const attendance = resolveAttendance(
        inputs.attendance,
        slot.date,
        slot.occasionId,
      );
      return [
        slot.key,
        [...attendance.dinerUserIds].sort(),
        attendance.guestCount,
        fixedMeal(inputs.fixed.get(slot.key)),
      ];
    }),
    brief: inputs.brief.trim(),
  });
}

function fixedMeal(choice: FixedChoice | undefined): FixedMeal | null {
  if (!choice) return null;
  return choice.kind === 'recipe'
    ? { kind: 'recipe', recipeId: choice.recipe.id }
    : { kind: choice.kind };
}

// The first proposal's input, or "Another go"'s: swapped slots go as Fixed
// recipes and discarded slots as fixed empty slots, so both survive the rerun.
export function buildProposeInput(
  inputs: WizardInputs,
  rerun: { review: ReviewState; note: string } | null,
): ProposePlanInput {
  const slots = wizardSlots(inputs.startDate, inputs.endDate, inputs.occasions);
  const brief = inputs.brief.trim();
  const note = rerun?.note.trim() ?? '';
  return {
    startDate: inputs.startDate,
    endDate: inputs.endDate,
    slots: slots.map((slot) => {
      const attendance = resolveAttendance(
        inputs.attendance,
        slot.date,
        slot.occasionId,
      );
      const status = rerun?.review.slots.get(slot.key)?.status;
      return {
        date: slot.date,
        occasionId: slot.occasionId,
        dinerUserIds: [...attendance.dinerUserIds],
        guestCount: attendance.guestCount,
        fixed:
          status?.kind === 'swapped'
            ? { kind: 'recipe', recipeId: status.recipe.id }
            : status?.kind === 'discarded'
              ? { kind: 'empty' }
              : fixedMeal(inputs.fixed.get(slot.key)),
      };
    }),
    brief: brief === '' ? null : brief,
    note: note === '' ? null : note,
    previous: rerun ? rerun.review.proposal : null,
  };
}

export function startReview(proposal: ProposePlanResult): ReviewState {
  return {
    slots: new Map(
      proposal.slots.map((suggestion) => [
        slotKey(suggestion.date, suggestion.occasionId),
        { suggestion, status: { kind: 'suggested' } },
      ]),
    ),
    summary: proposal.summary,
    dropped: proposal.dropped,
    proposal,
    anotherGoCount: 0,
  };
}

// Only slots still as suggested take the new proposal's suggestion. Swapped
// and discarded slots keep their status, and their old suggestion to restore.
export function rerunReview(
  review: ReviewState,
  proposal: ProposePlanResult,
): ReviewState {
  const slots = new Map(review.slots);
  for (const suggestion of proposal.slots) {
    const key = slotKey(suggestion.date, suggestion.occasionId);
    const existing = slots.get(key);
    if (existing && existing.status.kind !== 'suggested') continue;
    slots.set(key, { suggestion, status: { kind: 'suggested' } });
  }
  return {
    slots,
    summary: proposal.summary,
    dropped: proposal.dropped,
    proposal,
    anotherGoCount: review.anotherGoCount + 1,
  };
}

export function setReviewStatus(
  review: ReviewState,
  key: string,
  status: ReviewSlotStatus,
): ReviewState {
  const slot = review.slots.get(key);
  if (!slot) return review;
  const slots = new Map(review.slots);
  slots.set(key, { ...slot, status });
  return { ...review, slots };
}

interface SlotContent {
  slotType: PlanSlot['slotType'];
  leftoversSource: PlanSlot['leftoversSource'];
  items: Omit<PlanSlotItem, 'id'>[];
}

const EMPTY_CONTENT: SlotContent = {
  slotType: 'empty',
  leftoversSource: null,
  items: [],
};

// A recipe the cook chose eats the slot's headcount.
function recipeContent(recipe: RecipeChoice, eaten: number): SlotContent {
  return {
    slotType: 'recipe',
    leftoversSource: null,
    items: [
      {
        recipeId: recipe.id,
        recipeName: recipe.name,
        recipeImageUrl: recipe.imageUrl,
        isBase: recipe.isBase,
        baseRecipeId: recipe.baseRecipeId,
        isDeleted: false,
        prepared: eaten,
        eaten,
        sortOrder: 0,
      },
    ],
  };
}

function suggestionContent(suggestion: ProposedSlot): SlotContent {
  return {
    slotType: suggestion.slotType,
    leftoversSource: suggestion.leftoversSource,
    items: suggestion.items.map((item, index) => ({
      recipeId: item.recipeId,
      recipeName: item.recipeName,
      recipeImageUrl: item.recipeImageUrl,
      isBase: item.isBase,
      baseRecipeId: item.baseRecipeId,
      isDeleted: false,
      prepared: item.prepared,
      eaten: item.eaten,
      sortOrder: index,
    })),
  };
}

function hasDish(suggestion: ProposedSlot): boolean {
  return suggestion.items.length > 0;
}

// Every slot of the new plan as the cook has left it, shaped like the
// planner's slots so the slot card renders them. Ids are local to the review.
export function reviewPlanSlots(
  inputs: WizardInputs,
  review: ReviewState,
): ReviewPlanSlot[] {
  let itemId = 0;
  return wizardSlots(inputs.startDate, inputs.endDate, inputs.occasions).map(
    (ref, index) => {
      const attendance = resolveAttendance(
        inputs.attendance,
        ref.date,
        ref.occasionId,
      );
      const eaten = headcount(attendance);
      const fixed = inputs.fixed.get(ref.key);
      const reviewed = review.slots.get(ref.key);
      let kind: ReviewSlotKind;
      let content: SlotContent;
      let reason: string | null = null;
      if (fixed) {
        kind = 'fixed';
        content =
          fixed.kind === 'recipe'
            ? recipeContent(fixed.recipe, eaten)
            : { ...EMPTY_CONTENT, slotType: fixed.kind };
      } else if (reviewed?.status.kind === 'swapped') {
        kind = 'swapped';
        content = recipeContent(reviewed.status.recipe, eaten);
      } else if (reviewed?.status.kind === 'discarded') {
        kind = 'discarded';
        content = EMPTY_CONTENT;
      } else if (reviewed && hasDish(reviewed.suggestion)) {
        kind = 'suggested';
        content = suggestionContent(reviewed.suggestion);
        reason = reviewed.suggestion.reason;
      } else {
        kind = 'unfilled';
        content = EMPTY_CONTENT;
      }
      const slot: PlanSlot = {
        id: index + 1,
        planId: 1,
        date: ref.date,
        occasionId: ref.occasionId,
        occasionName: ref.occasionName,
        slotType: content.slotType,
        leftoversSource: content.leftoversSource,
        chefUserId: null,
        comment: null,
        items: content.items.map((item) => {
          itemId += 1;
          return { ...item, id: itemId };
        }),
        dinerUserIds: [...attendance.dinerUserIds],
        guestCount: attendance.guestCount,
      };
      return {
        slot,
        kind,
        reason,
        canSwap: kind !== 'fixed' && eaten > 0,
      };
    },
  );
}

export function figuresInput(
  slots: readonly ReviewPlanSlot[],
): ProposedFiguresInput {
  return {
    dishes: slots.flatMap(({ slot }) =>
      slot.items
        .filter((item) => item.eaten > 0)
        .map((item) => ({
          date: slot.date,
          recipeId: item.recipeId,
          eaten: item.eaten,
        })),
    ),
  };
}

export function reviewCounts(review: ReviewState): PlanReviewCounts {
  let suggested = 0;
  let swapped = 0;
  let discarded = 0;
  for (const slot of review.slots.values()) {
    if (hasDish(slot.suggestion)) suggested += 1;
    if (slot.status.kind === 'swapped') swapped += 1;
    if (slot.status.kind === 'discarded') discarded += 1;
  }
  return {
    suggested,
    swapped,
    discarded,
    suggestedAgain: 0,
    anotherGo: review.anotherGoCount,
  };
}

// Apply's input: every slot's attendance, the Fixed meals, the kept
// proposals, and discarded slots empty. Reasons and the summary stay behind.
export function buildApplyInput(
  inputs: WizardInputs,
  review: ReviewState,
): CreatePlanWithSlotsInput {
  return {
    startDate: inputs.startDate,
    endDate: inputs.endDate,
    slots: reviewPlanSlots(inputs, review).map(
      ({ slot }): ApplyPlanSlot => ({
        date: slot.date,
        occasionId: slot.occasionId,
        slotType: slot.slotType,
        leftoversSource: slot.leftoversSource,
        items: slot.items.map((item) => ({
          recipeId: item.recipeId,
          prepared: item.prepared,
          eaten: item.eaten,
          sortOrder: item.sortOrder,
        })),
        dinerUserIds: slot.dinerUserIds,
        guestCount: slot.guestCount,
      }),
    ),
    reviewCounts: reviewCounts(review),
  };
}
