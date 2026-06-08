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
