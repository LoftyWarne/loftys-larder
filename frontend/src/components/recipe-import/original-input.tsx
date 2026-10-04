import type { RecipeImageView, RecipeImportInput } from '@loftys-larder/shared';

import { OriginalImages } from '@/components/original-images.tsx';

export interface OriginalInputProps {
  input: RecipeImportInput;
  // An image import's images, in page order.
  images: readonly RecipeImageView[];
  // Below `lg` the original folds away above the proposal; at `lg` and wider
  // it stays beside it.
  collapsible: boolean;
}

// The import input as the cook gave it, to check the proposal against
// (DEC-103). Plain text only (DEC-49).
export function OriginalInput({
  input,
  images,
  collapsible,
}: OriginalInputProps): React.ReactElement {
  const title = input.kind === 'text' ? 'Original text' : 'Original images';
  const body =
    input.kind === 'text' ? (
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
        {input.text}
      </pre>
    ) : (
      <OriginalImages images={images} />
    );

  if (collapsible) {
    return (
      <details className="rounded-md border border-input p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {title}
        </summary>
        {/* Focusable so the scrolling region can be scrolled by keyboard. */}
        <div tabIndex={0} className="mt-3 max-h-[60vh] overflow-y-auto">
          {body}
        </div>
      </details>
    );
  }

  return (
    <aside
      aria-labelledby="import-original-heading"
      className="space-y-2 self-start rounded-md border border-input p-3 lg:sticky lg:top-4"
    >
      <h2 id="import-original-heading" className="text-sm font-semibold">
        {title}
      </h2>
      <div tabIndex={0} className="max-h-[calc(100vh-6rem)] overflow-y-auto">
        {body}
      </div>
    </aside>
  );
}
