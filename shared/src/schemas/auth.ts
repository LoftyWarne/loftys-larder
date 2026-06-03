import { z } from 'zod';

export const signInSchema = z.object({
  email: z.email().trim(),
});

export type SignInInput = z.infer<typeof signInSchema>;
