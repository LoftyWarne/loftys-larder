import {
  RECIPE_IMPORT_IMAGE_ALLOWED_FORMATS,
  RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE,
  RECIPE_IMPORT_IMAGES_MAX,
} from '@loftys-larder/shared';
import { ImageIcon } from 'lucide-react';
import { useRef } from 'react';

import { Button } from '@/components/ui/button.tsx';
import { fileSizeLimitMessage } from '@/lib/cloudinary-upload.ts';
import { formatFileSize } from '@/lib/import-documents.ts';

// Browsers don't all give HEIC a MIME type, so the extension counts too.
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,.heic';
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);
const ALLOWED_EXTENSIONS = new Set<string>(RECIPE_IMPORT_IMAGE_ALLOWED_FORMATS);

function isAllowedImage(file: File): boolean {
  const extension = file.name.includes('.')
    ? (file.name.split('.').pop() ?? '').toLowerCase()
    : '';
  return ALLOWED_TYPES.has(file.type) || ALLOWED_EXTENSIONS.has(extension);
}

// Adds the picked or dropped images that pass the checks, up to the limit,
// and says what was left out and why.
export function addImportImages(
  files: readonly File[],
  picked: readonly File[],
): { files: File[]; problems: string[] } {
  const problems: string[] = [];
  const accepted: File[] = [];
  let overLimit = false;
  for (const file of picked) {
    if (!isAllowedImage(file)) {
      problems.push(`${file.name} isn’t a JPG, PNG, WebP or HEIC image.`);
    } else if (file.size > RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE) {
      problems.push(
        `${file.name}: ${fileSizeLimitMessage(RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE)}.`,
      );
    } else if (files.length + accepted.length >= RECIPE_IMPORT_IMAGES_MAX) {
      overLimit = true;
    } else {
      accepted.push(file);
    }
  }
  if (overLimit) {
    problems.push(
      `Up to ${String(RECIPE_IMPORT_IMAGES_MAX)} images can be imported at once, so not all of them were added.`,
    );
  }
  return { files: [...files, ...accepted], problems };
}

export interface ImportImagePickerProps {
  // In page order.
  files: readonly File[];
  onFilesChange: (files: File[]) => void;
  // What the last pick, drop or removal left out. The page holds them, so a
  // drop can report through the picker too.
  problems: readonly string[];
  onProblemsChange: (problems: string[]) => void;
  disabled: boolean;
}

// Choosing the 1–8 photos, screenshots or scans to import, from the camera
// or from files (DEC-107). Nothing uploads until the cook imports.
export function ImportImagePicker({
  files,
  onFilesChange,
  problems,
  onProblemsChange,
  disabled,
}: ImportImagePickerProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const full = files.length >= RECIPE_IMPORT_IMAGES_MAX;

  function addFiles(picked: readonly File[]): void {
    const added = addImportImages(files, picked);
    onProblemsChange(added.problems);
    if (added.files.length > files.length) onFilesChange(added.files);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Up to {RECIPE_IMPORT_IMAGES_MAX} photos, screenshots or scans of one
        recipe, in page order: JPG, PNG, WebP or HEIC, up to{' '}
        {formatFileSize(RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE)} each.
      </p>

      {files.length > 0 && (
        <ol aria-label="Chosen images" className="space-y-2">
          {files.map((file, index) => (
            <li
              // A file has no id, and the same one can't be chosen twice in
              // a row without a change in between.
              key={`${String(index)}-${file.name}-${String(file.size)}`}
              className="flex items-center gap-3 rounded-md border border-input p-2"
            >
              <ImageIcon
                className="h-5 w-5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  Page {index + 1} · {formatFileSize(file.size)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={`Remove ${file.name}`}
                onClick={() => {
                  onProblemsChange([]);
                  onFilesChange(files.filter((_, at) => at !== index));
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ol>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        aria-label="Choose images to import"
        disabled={disabled || full}
        className="sr-only"
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || full}
          onClick={() => {
            inputRef.current?.click();
          }}
        >
          {files.length === 0 ? 'Choose images' : 'Add another image'}
        </Button>
        {full && (
          <p className="text-sm text-muted-foreground">
            That&rsquo;s the most for one import.
          </p>
        )}
      </div>

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 text-sm text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
