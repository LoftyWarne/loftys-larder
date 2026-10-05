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

// Recipe Import images (DEC-107): a second preset with its own folder, HEIC
// for iPhone photos, and room for full-size phone photos.
export const RECIPE_IMPORT_IMAGE_ALLOWED_FORMATS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
] as const;

export const RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE = 10_485_760;

export const RECIPE_IMPORT_IMAGE_FOLDER = 'loftys-larder/imports';

// One JPEG rendition, made at upload: its long edge is the most the reader's
// model takes without downscaling, and it's what the reader is sent and the
// cook sees, so a HEIC photo works everywhere.
export const RECIPE_IMPORT_IMAGE_EAGER_TRANSFORMATION =
  'c_limit,w_2576,h_2576,f_jpg,q_auto';

export const recipeImportImageUploadCredentialsSchema = z.object({
  cloudName: z.string().min(1),
  apiKey: z.string().min(1),
  timestamp: z.number().int().positive(),
  signature: z.string().regex(/^[a-f0-9]{40}$/, 'expected SHA-1 hex digest'),
  folder: z.literal(RECIPE_IMPORT_IMAGE_FOLDER),
  allowedFormats: z.tuple([
    z.literal('jpg'),
    z.literal('jpeg'),
    z.literal('png'),
    z.literal('webp'),
    z.literal('heic'),
  ]),
  maxFileSize: z.literal(RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE),
  transformation: z.literal(RECIPE_IMPORT_IMAGE_EAGER_TRANSFORMATION),
});

export type RecipeImportImageUploadCredentials = z.infer<
  typeof recipeImportImageUploadCredentialsSchema
>;

// Recipe Import PDFs (DEC-111): the same folder, PDF only, and no
// transformation, because the reader is sent the PDF itself. Cloudinary
// keeps a PDF as an image resource, so the image endpoints take it.
export const RECIPE_IMPORT_PDF_ALLOWED_FORMATS = ['pdf'] as const;

export const RECIPE_IMPORT_PDF_MAX_FILE_SIZE = 10_485_760;

export const recipeImportPdfUploadCredentialsSchema = z.object({
  cloudName: z.string().min(1),
  apiKey: z.string().min(1),
  timestamp: z.number().int().positive(),
  signature: z.string().regex(/^[a-f0-9]{40}$/, 'expected SHA-1 hex digest'),
  folder: z.literal(RECIPE_IMPORT_IMAGE_FOLDER),
  allowedFormats: z.tuple([z.literal('pdf')]),
  maxFileSize: z.literal(RECIPE_IMPORT_PDF_MAX_FILE_SIZE),
});

export type RecipeImportPdfUploadCredentials = z.infer<
  typeof recipeImportPdfUploadCredentialsSchema
>;
