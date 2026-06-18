import { z } from 'zod';

export const themePreferenceSchema = z.enum(['system', 'light', 'dark']);

export type ThemePreference = z.infer<typeof themePreferenceSchema>;

export const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(120, 'Name must be 120 characters or fewer');

export const updateProfileInputSchema = z
  .object({
    name: nameSchema.optional(),
    themePreference: themePreferenceSchema.optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.themePreference !== undefined,
    { message: 'Provide at least one field to update' },
  );

export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

export const meSchema = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  themePreference: themePreferenceSchema,
});

export type Me = z.infer<typeof meSchema>;

// Account-deletion gating: the user must re-type their own email into the
// confirmation dialog. The server re-checks against `ctx.user.email` so the
// dialog gate isn't the only line of defence (DEC-29).
export const deleteAccountInputSchema = z.object({
  emailConfirmation: z.string().trim().min(1),
});

export type DeleteAccountInput = z.infer<typeof deleteAccountInputSchema>;

export const deleteAccountResultSchema = z.object({
  deleted: z.literal(true),
});

export type DeleteAccountResult = z.infer<typeof deleteAccountResultSchema>;

// Pre-deletion summary surfaces the counts that will be *tombstoned*
// (NULLed and survive), not the rows that are hard-deleted. Ratings and
// drafts are the user's personal records and aren't shown.
export const deletionSummarySchema = z.object({
  commentCount: z.number().int().nonnegative(),
  recipeCount: z.number().int().nonnegative(),
  planCount: z.number().int().nonnegative(),
});

export type DeletionSummary = z.infer<typeof deletionSummarySchema>;
