import { z } from 'zod';

// Plant points are a computed COUNT(DISTINCT ingredient_id) over plant
// ingredients (DEC-32). Day and plan procedures compose the recipe-level
// primitive by unioning three contribution sources per slot: the eating
// recipe, the eating recipe's base (for batch-version meals), and the
// independently-cooked base. DISTINCT handles the dedup, including the
// case where a slot's referenced base equals the cooked base.

const planIdSchema = z.number().int().positive();
const civilDateSchema = z.iso.date();

const plantPointsCountSchema = z.number().int().nonnegative();

export const getDayPlantPointsInputSchema = z.object({
  planId: planIdSchema,
  date: civilDateSchema,
});
export type GetDayPlantPointsInput = z.infer<
  typeof getDayPlantPointsInputSchema
>;

export const getDayPlantPointsResultSchema = z.object({
  count: plantPointsCountSchema,
});
export type GetDayPlantPointsResult = z.infer<
  typeof getDayPlantPointsResultSchema
>;

export const getPlanPlantPointsInputSchema = z.object({
  planId: planIdSchema,
});
export type GetPlanPlantPointsInput = z.infer<
  typeof getPlanPlantPointsInputSchema
>;

export const getPlanPlantPointsResultSchema = z.object({
  count: plantPointsCountSchema,
});
export type GetPlanPlantPointsResult = z.infer<
  typeof getPlanPlantPointsResultSchema
>;
