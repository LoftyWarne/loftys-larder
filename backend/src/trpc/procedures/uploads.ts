import {
  RECIPE_IMAGE_ALLOWED_FORMATS,
  RECIPE_IMAGE_EAGER_TRANSFORMATION,
  RECIPE_IMAGE_FOLDER,
  RECIPE_IMAGE_MAX_FILE_SIZE,
  recipeImageUploadCredentialsSchema,
  type RecipeImageUploadCredentials,
} from '../../../../shared/src/index.ts';
import { signUploadParams } from '../../lib/cloudinary.ts';
import { protectedProcedure, router } from '../init.ts';

export const uploadsRouter = router({
  getRecipeImageCredentials: protectedProcedure
    .output(recipeImageUploadCredentialsSchema)
    .query(({ ctx }): RecipeImageUploadCredentials => {
      // Cloudinary's `timestamp` parameter is Unix seconds — a protocol field
      // measured at UTC, not a domain date — so `dateUtils` doesn't apply.
      // Cloudinary rejects timestamps more than ~1 hour off, giving the
      // signature its short-lived window.
      const timestamp = Math.floor(Date.now() / 1000);

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
});
