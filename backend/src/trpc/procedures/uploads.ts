import {
  RECIPE_IMAGE_ALLOWED_FORMATS,
  RECIPE_IMAGE_EAGER_TRANSFORMATION,
  RECIPE_IMAGE_FOLDER,
  RECIPE_IMAGE_MAX_FILE_SIZE,
  RECIPE_IMPORT_IMAGE_ALLOWED_FORMATS,
  RECIPE_IMPORT_IMAGE_EAGER_TRANSFORMATION,
  RECIPE_IMPORT_IMAGE_FOLDER,
  RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE,
  RECIPE_IMPORT_PDF_ALLOWED_FORMATS,
  RECIPE_IMPORT_PDF_MAX_FILE_SIZE,
  recipeImageUploadCredentialsSchema,
  recipeImportImageUploadCredentialsSchema,
  recipeImportPdfUploadCredentialsSchema,
  type RecipeImageUploadCredentials,
  type RecipeImportImageUploadCredentials,
  type RecipeImportPdfUploadCredentials,
} from '../../../../shared/src/index.ts';
import { signUploadParams } from '../../lib/cloudinary.ts';
import { protectedProcedure, router } from '../init.ts';

// Cloudinary's `timestamp` parameter is Unix seconds — a protocol field
// measured at UTC, not a domain date — so `dateUtils` doesn't apply.
// Cloudinary rejects timestamps more than ~1 hour off, giving the signature
// its short-lived window.
function uploadTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

export const uploadsRouter = router({
  getRecipeImageCredentials: protectedProcedure
    .output(recipeImageUploadCredentialsSchema)
    .query(({ ctx }): RecipeImageUploadCredentials => {
      const timestamp = uploadTimestamp();

      // NOTE: `max_file_size` is intentionally NOT signed and NOT posted —
      // it is a Pro-plan-only Cloudinary upload param. On lower plans
      // Cloudinary strips it before signature verification, so including it
      // here would produce a server signature over a different string than
      // Cloudinary checks against → 401 "Invalid Signature". The cap is
      // enforced client-side instead (the credential carries `maxFileSize`
      // for the uploader to compare against `file.size`).
      const signature = signUploadParams(
        {
          allowed_formats: RECIPE_IMAGE_ALLOWED_FORMATS.join(','),
          eager: RECIPE_IMAGE_EAGER_TRANSFORMATION,
          folder: RECIPE_IMAGE_FOLDER,
          timestamp,
        },
        ctx.cloudinary.apiSecret,
      );

      return {
        cloudName: ctx.cloudinary.cloudName,
        apiKey: ctx.cloudinary.apiKey,
        timestamp,
        signature,
        folder: RECIPE_IMAGE_FOLDER,
        allowedFormats: ['jpg', 'jpeg', 'png', 'webp'],
        maxFileSize: RECIPE_IMAGE_MAX_FILE_SIZE,
        transformation: RECIPE_IMAGE_EAGER_TRANSFORMATION,
      };
    }),

  // Recipe Import images (DEC-107): their own folder, HEIC allowed, and the
  // JPEG rendition the reader is sent made at upload. The size limit is
  // enforced client-side, as above.
  getRecipeImportImageCredentials: protectedProcedure
    .output(recipeImportImageUploadCredentialsSchema)
    .query(({ ctx }): RecipeImportImageUploadCredentials => {
      const timestamp = uploadTimestamp();
      const signature = signUploadParams(
        {
          allowed_formats: RECIPE_IMPORT_IMAGE_ALLOWED_FORMATS.join(','),
          eager: RECIPE_IMPORT_IMAGE_EAGER_TRANSFORMATION,
          folder: RECIPE_IMPORT_IMAGE_FOLDER,
          timestamp,
        },
        ctx.cloudinary.apiSecret,
      );

      return {
        cloudName: ctx.cloudinary.cloudName,
        apiKey: ctx.cloudinary.apiKey,
        timestamp,
        signature,
        folder: RECIPE_IMPORT_IMAGE_FOLDER,
        allowedFormats: ['jpg', 'jpeg', 'png', 'webp', 'heic'],
        maxFileSize: RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE,
        transformation: RECIPE_IMPORT_IMAGE_EAGER_TRANSFORMATION,
      };
    }),

  // A PDF Document (DEC-111): the imports folder, PDF only, and nothing made
  // at upload, because the reader is sent the PDF itself. The size limit is
  // enforced client-side, as above, and checked again before it's read.
  getRecipeImportPdfCredentials: protectedProcedure
    .output(recipeImportPdfUploadCredentialsSchema)
    .query(({ ctx }): RecipeImportPdfUploadCredentials => {
      const timestamp = uploadTimestamp();
      const signature = signUploadParams(
        {
          allowed_formats: RECIPE_IMPORT_PDF_ALLOWED_FORMATS.join(','),
          folder: RECIPE_IMPORT_IMAGE_FOLDER,
          timestamp,
        },
        ctx.cloudinary.apiSecret,
      );

      return {
        cloudName: ctx.cloudinary.cloudName,
        apiKey: ctx.cloudinary.apiKey,
        timestamp,
        signature,
        folder: RECIPE_IMPORT_IMAGE_FOLDER,
        allowedFormats: ['pdf'],
        maxFileSize: RECIPE_IMPORT_PDF_MAX_FILE_SIZE,
      };
    }),
});
