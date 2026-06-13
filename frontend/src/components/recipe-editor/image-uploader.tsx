import type { RecipeImageUploadCredentials } from '@loftys-larder/shared';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button.tsx';

export interface ImageUploaderProps {
  imageUrl: string | null;
  getCredentials: () => Promise<RecipeImageUploadCredentials>;
  onUploaded: (secureUrl: string | null) => Promise<void> | void;
}

interface CloudinaryUploadResponse {
  secure_url?: unknown;
}

const CLOUDINARY_HOST = 'https://api.cloudinary.com';

export function ImageUploader({
  imageUrl,
  getCredentials,
  onUploaded,
}: ImageUploaderProps): React.ReactElement {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setUploading(true);
    try {
      const creds = await getCredentials();

      // Enforce the file-size cap client-side. Cloudinary's `max_file_size`
      // upload param is Pro-plan-only; on lower plans it gets stripped before
      // signature verification, which produces a 401 if we include it in the
      // signed body. So the credential carries the cap and we check here.
      if (file.size > creds.maxFileSize) {
        const mb = (creds.maxFileSize / 1_048_576).toFixed(1);
        throw new Error(`Image must be ${mb} MB or smaller`);
      }

      const url = `${CLOUDINARY_HOST}/v1_1/${creds.cloudName}/image/upload`;

      // Cloudinary's wire-side parameter names are snake_case (the signature
      // is computed over those exact names). Building the body in camelCase
      // would produce a signature mismatch and a 401 on every upload.
      const formData = new FormData();
      formData.append('file', file);
      formData.append('api_key', creds.apiKey);
      formData.append('timestamp', String(creds.timestamp));
      formData.append('signature', creds.signature);
      formData.append('folder', creds.folder);
      formData.append('allowed_formats', creds.allowedFormats.join(','));
      formData.append('eager', creds.transformation);

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        // Cloudinary surfaces the real cause (invalid signature, stale
        // timestamp, plan-restricted param, etc.) in the response body —
        // capture it so the user / logs see what failed instead of a bare
        // status code.
        const body = await response.text();
        throw new Error(
          `Cloudinary returned ${String(response.status)}: ${body}`,
        );
      }
      const payload = (await response.json()) as CloudinaryUploadResponse;
      const secureUrl = payload.secure_url;
      if (typeof secureUrl !== 'string' || secureUrl.length === 0) {
        throw new Error('Cloudinary response missing secure_url');
      }
      await onUploaded(secureUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      setError(message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleRemove(): Promise<void> {
    setError(null);
    try {
      await onUploaded(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to clear image';
      setError(message);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="recipe-image-heading">
      <h2 id="recipe-image-heading" className="text-lg font-semibold">
        Photo
      </h2>

      {imageUrl ? (
        <div className="space-y-2">
          <img
            src={imageUrl}
            alt="Recipe"
            className="aspect-[4/3] w-full max-w-sm rounded-lg object-cover"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void handleRemove();
            }}
          >
            Remove image
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No image yet.</p>
      )}

      <div className="flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="Upload recipe image"
          disabled={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void handleFile(file);
            }
          }}
          className="sr-only"
        />
        <Button
          type="button"
          variant="outline"
          disabled={uploading}
          onClick={() => {
            fileInputRef.current?.click();
          }}
        >
          {imageUrl ? 'Replace image' : 'Choose image'}
        </Button>
        {uploading && (
          <p role="status" className="text-sm text-muted-foreground">
            Uploading…
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
