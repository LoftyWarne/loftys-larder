import { z } from 'zod';

export const RECIPE_IMAGE_ALLOWED_FORMATS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
] as const;

export const RECIPE_IMAGE_MAX_FILE_SIZE = 5_242_880;

export const RECIPE_IMAGE_FOLDER = 'loftys-larder/recipes';

export const RECIPE_IMAGE_EAGER_TRANSFORMATION =
  'c_fill,w_1200,h_900,q_auto,f_auto';

export const recipeImageUploadCredentialsSchema = z.object({
  cloudName: z.string().min(1),
  apiKey: z.string().min(1),
  timestamp: z.number().int().positive(),
  signature: z.string().regex(/^[a-f0-9]{40}$/, 'expected SHA-1 hex digest'),
  folder: z.literal(RECIPE_IMAGE_FOLDER),
  allowedFormats: z.tuple([
    z.literal('jpg'),
    z.literal('jpeg'),
    z.literal('png'),
    z.literal('webp'),
  ]),
  maxFileSize: z.literal(RECIPE_IMAGE_MAX_FILE_SIZE),
  transformation: z.literal(RECIPE_IMAGE_EAGER_TRANSFORMATION),
});

export type RecipeImageUploadCredentials = z.infer<
  typeof recipeImageUploadCredentialsSchema
>;
