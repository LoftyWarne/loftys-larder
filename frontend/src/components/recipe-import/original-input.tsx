import type { RecipeImportInput } from '@loftys-larder/shared';

export interface OriginalInputProps {
  input: RecipeImportInput;
  // Below `lg` the original folds away above the proposal; at `lg` and wider
  // it stays beside it.
  collapsible: boolean;
}

// The import input as the cook gave it, to check the proposal against
// (DEC-103). Plain text only (DEC-49).
export function OriginalInput({
  input,
  collapsible,
}: OriginalInputProps): React.ReactElement {
  const body = (
    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
      {input.text}
    </pre>
  );

  if (collapsible) {
    return (
      <details className="rounded-md border border-input p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Original text
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
        Original text
      </h2>
      <div tabIndex={0} className="max-h-[calc(100vh-6rem)] overflow-y-auto">
        {body}
      </div>
    </aside>
  );
}
