import type { RecipeImageView } from '@loftys-larder/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.tsx';

function pageLabel(index: number, count: number): string {
  return count === 1
    ? 'Original'
    : `Page ${String(index + 1)} of ${String(count)}`;
}

export interface OriginalImagesDialogProps {
  images: readonly RecipeImageView[];
  // The page shown, or null when closed.
  index: number | null;
  onIndexChange: (index: number | null) => void;
}

// One page of an import's images at a time, as large as the screen allows,
// with a link to the full-size image for zooming (DEC-107).
export function OriginalImagesDialog({
  images,
  index,
  onIndexChange,
}: OriginalImagesDialogProps): React.ReactElement {
  const image = index === null ? undefined : images[index];
  const shown = index ?? 0;
  const label = pageLabel(shown, images.length);

  return (
    <Dialog
      open={image !== undefined}
      onOpenChange={(open) => {
        if (!open) onIndexChange(null);
      }}
    >
      <DialogContent className="max-h-[95vh] max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto] p-4 sm:p-6">
        <div className="pr-8">
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription className="sr-only">
            The image the recipe was imported from.
          </DialogDescription>
        </div>
        {image && (
          <img
            src={image.url}
            alt={label}
            className="mx-auto max-h-[75vh] w-full object-contain"
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <a
            href={image?.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm underline"
          >
            Open full size
          </a>
          {images.length > 1 && (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={shown === 0}
                onClick={() => {
                  onIndexChange(shown - 1);
                }}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
                Previous page
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={shown === images.length - 1}
                onClick={() => {
                  onIndexChange(shown + 1);
                }}
              >
                Next page
                <ChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface OriginalImagesProps {
  images: readonly RecipeImageView[];
}

// An import's images in page order, each of which can be enlarged.
export function OriginalImages({
  images,
}: OriginalImagesProps): React.ReactElement {
  const [index, setIndex] = useState<number | null>(null);

  return (
    <>
      <ol className="space-y-3">
        {images.map((image, position) => (
          <li key={image.url}>
            <button
              type="button"
              className="block w-full overflow-hidden rounded-md border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Enlarge ${pageLabel(position, images.length).toLowerCase()}`}
              onClick={() => {
                setIndex(position);
              }}
            >
              <img
                src={image.url}
                alt={pageLabel(position, images.length)}
                loading="lazy"
                className="w-full"
              />
            </button>
          </li>
        ))}
      </ol>
      <OriginalImagesDialog
        images={images}
        index={index}
        onIndexChange={setIndex}
      />
    </>
  );
}

export interface ViewOriginalButtonProps {
  images: readonly RecipeImageView[];
}

// On a recipe imported from images: its Originals, from the first page.
export function ViewOriginalButton({
  images,
}: ViewOriginalButtonProps): React.ReactElement {
  const [index, setIndex] = useState<number | null>(null);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setIndex(0);
        }}
      >
        View original
      </Button>
      <OriginalImagesDialog
        images={images}
        index={index}
        onIndexChange={setIndex}
      />
    </>
  );
}
