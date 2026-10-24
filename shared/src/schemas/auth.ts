import { z } from 'zod';

export const signInSchema = z.object({
  email: z.email().trim(),
});

export type SignInInput = z.infer<typeof signInSchema>;

// Spaces are dropped so a pasted "123 456" or a padded code still counts.
export const signInCodeSchema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/\s/g, ''))
    .pipe(
      z.string().regex(/^\d{8}$/, 'Enter the 8-digit code from the email.'),
    ),
});

export type SignInCodeInput = z.infer<typeof signInCodeSchema>;
