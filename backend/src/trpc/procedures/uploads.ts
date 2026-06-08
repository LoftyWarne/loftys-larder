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

      const signature = signUploadParams(
        {
          allowed_formats: RECIPE_IMAGE_ALLOWED_FORMATS.join(','),
          eager: RECIPE_IMAGE_EAGER_TRANSFORMATION,
          folder: RECIPE_IMAGE_FOLDER,
          max_file_size: RECIPE_IMAGE_MAX_FILE_SIZE,
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
