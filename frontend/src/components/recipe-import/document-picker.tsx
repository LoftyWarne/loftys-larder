import {
  RECIPE_IMPORT_DOCUMENT_MAX_FILE_SIZE,
  RECIPE_IMPORT_TEXT_MAX_LENGTH,
} from '@loftys-larder/shared';
import { FileText } from 'lucide-react';
import { useRef } from 'react';

import { Button } from '@/components/ui/button.tsx';
import {
  DOCUMENT_ACCEPT,
  formatFileSize,
  type ImportDocument,
} from '@/lib/import-documents.ts';

const KIND_LABELS: Record<ImportDocument['kind'], string> = {
  text: 'Text file',
  html: 'Saved web page',
  pdf: 'PDF',
};

export interface DocumentPickerProps {
  value: ImportDocument | null;
  // Why the last file picked or dropped wasn't taken.
  problem: string | null;
  disabled: boolean;
  onFile: (file: File) => void;
  onTextChange: (text: string) => void;
  onRemove: () => void;
}

// Choosing the one Document to import (DEC-111). A text or Markdown file
// opens in a text box the cook can trim before importing it as pasted text.
// A PDF of up to 8 pages is uploaded on Import.
export function DocumentPicker({
  value,
  problem,
  disabled,
  onFile,
  onTextChange,
  onRemove,
}: DocumentPickerProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        A PDF, text, Markdown or web page (.html) file holding the recipe, up to{' '}
        {formatFileSize(RECIPE_IMPORT_DOCUMENT_MAX_FILE_SIZE)}. You can also
        drop a file anywhere on this page.
      </p>

      {value && (
        <div className="flex items-center gap-3 rounded-md border border-input p-2">
          <FileText
            className="h-5 w-5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{value.fileName}</p>
            <p className="text-xs text-muted-foreground">
              {KIND_LABELS[value.kind]} · {formatFileSize(value.size)}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Remove ${value.fileName}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        aria-label="Choose a document to import"
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        {value ? 'Choose another file' : 'Choose a file'}
      </Button>

      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}

      {value?.kind === 'text' && (
        <div className="space-y-2">
          <label
            htmlFor="import-document-text"
            className="block break-all text-sm font-medium"
          >
            From {value.fileName}
          </label>
          {value.truncated && (
            <p className="text-sm text-muted-foreground">
              Only the first{' '}
              {RECIPE_IMPORT_TEXT_MAX_LENGTH.toLocaleString('en-GB')} characters
              were loaded. Trim it to the recipe.
            </p>
          )}
          <textarea
            id="import-document-text"
            rows={12}
            maxLength={RECIPE_IMPORT_TEXT_MAX_LENGTH}
            disabled={disabled}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            value={value.text}
            onChange={(event) => {
              onTextChange(event.target.value);
            }}
          />
        </div>
      )}
    </div>
  );
}
