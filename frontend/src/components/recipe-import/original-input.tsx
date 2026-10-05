import type {
  RecipeImageView,
  RecipeImportStoredInput,
} from '@loftys-larder/shared';

import { OriginalImages } from '@/components/original-images.tsx';

export interface OriginalInputProps {
  input: RecipeImportStoredInput;
  // An image import's images, in page order.
  images: readonly RecipeImageView[];
  // Below `lg` the original folds away above the proposal; at `lg` and wider
  // it stays beside it.
  collapsible: boolean;
}

const TITLES: Record<RecipeImportStoredInput['kind'], string> = {
  text: 'Original text',
  images: 'Original images',
  link: 'Original page',
  html: 'Original document',
};

// The import input as the cook gave it, to check the proposal against
// (DEC-103). Plain text only (DEC-49).
export function OriginalInput({
  input,
  images,
  collapsible,
}: OriginalInputProps): React.ReactElement {
  const title = TITLES[input.kind];
  const body =
    input.kind === 'text' ? (
      <OriginalText text={input.text} />
    ) : input.kind === 'images' ? (
      <OriginalImages images={images} />
    ) : input.kind === 'link' ? (
      <OriginalLink url={input.url} />
    ) : (
      <div className="space-y-3">
        <div className="space-y-1">
          <p className="break-all text-sm font-medium">{input.fileName}</p>
          {input.sourceUrl !== null && <OriginalLink url={input.sourceUrl} />}
        </div>
        {input.text === '' ? (
          <p className="text-sm text-muted-foreground">
            This page has no readable text.
          </p>
        ) : (
          <OriginalText text={input.text} />
        )}
      </div>
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

function OriginalText({ text }: { text: string }): React.ReactElement {
  return (
    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
      {text}
    </pre>
  );
}

// The page opens beside Import Review. The draft's input comes back through
// autosave, so only an https link is made clickable.
function OriginalLink({ url }: { url: string }): React.ReactElement {
  if (!isHttps(url)) {
    return <p className="break-all text-sm">{url}</p>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-sm underline underline-offset-2 hover:text-primary"
    >
      {url}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function isHttps(url: string): boolean {
  return URL.canParse(url) && new URL(url).protocol === 'https:';
}
