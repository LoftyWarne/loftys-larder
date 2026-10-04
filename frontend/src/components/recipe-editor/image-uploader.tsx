import type { RecipeImageUploadCredentials } from '@loftys-larder/shared';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button.tsx';
import { uploadToCloudinary } from '@/lib/cloudinary-upload.ts';

export interface ImageUploaderProps {
  imageUrl: string | null;
  getCredentials: () => Promise<RecipeImageUploadCredentials>;
  onUploaded: (secureUrl: string | null) => Promise<void> | void;
}

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
      const { secureUrl } = await uploadToCloudinary(file, creds);
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
        <img
          src={imageUrl}
          alt="Recipe"
          className="aspect-[4/3] w-full max-w-sm rounded-lg object-cover"
        />
      ) : (
        <p className="text-sm text-muted-foreground">No image yet.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
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
        {imageUrl && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void handleRemove();
            }}
          >
            Remove image
          </Button>
        )}
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
