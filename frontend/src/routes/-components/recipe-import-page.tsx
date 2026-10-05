import type {
  RecipeImportDraftSummary,
  RecipeImportInput,
} from '@loftys-larder/shared';
import {
  RECIPE_IMPORT_IMAGES_MAX,
  RECIPE_IMPORT_LINK_MAX_LENGTH,
  RECIPE_IMPORT_PDF_PAGES_MAX,
  RECIPE_IMPORT_TEXT_MAX_LENGTH,
} from '@loftys-larder/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { DiscardImportButton } from '@/components/recipe-import/discard-import-button.tsx';
import { DocumentPicker } from '@/components/recipe-import/document-picker.tsx';
import {
  addImportImages,
  ImportImagePicker,
} from '@/components/recipe-import/import-image-picker.tsx';
import { useFileDrop } from '@/components/recipe-import/use-file-drop.ts';
import { Button } from '@/components/ui/button.tsx';
import { useOnlineStatus } from '@/hooks/use-online-status.ts';
import { uploadToCloudinary } from '@/lib/cloudinary-upload.ts';
import { getDomainErrorCause } from '@/lib/domain-error.ts';
import {
  readImportDocument,
  sortDroppedFiles,
  type ImportDocument,
} from '@/lib/import-documents.ts';
import { trpc } from '@/lib/trpc.ts';

type InputKind = RecipeImportInput['kind'];

// Document mode sends a text or Markdown file as pasted text, a saved web
// page as its markup, and a PDF as an upload (DEC-111).
type ImportMode = 'text' | 'images' | 'link' | 'document';

const MODES: { mode: ImportMode; label: string }[] = [
  { mode: 'text', label: 'Paste text' },
  { mode: 'images', label: 'Photos' },
  { mode: 'link', label: 'Link' },
  { mode: 'document', label: 'Document' },
];

// What "several recipes" and "back" refer to, by the input sent.
const INPUT_WORDS: Record<InputKind, { several: string; back: string }> = {
  text: {
    several: 'That text has more than one recipe. Which one?',
    back: 'Back to the text',
  },
  images: {
    several: 'Those images have more than one recipe. Which one?',
    back: 'Back to the images',
  },
  link: {
    several: 'That page has more than one recipe. Which one?',
    back: 'Back to the link',
  },
  html: {
    several: 'That page has more than one recipe. Which one?',
    back: 'Back to the document',
  },
  pdf: {
    several: 'That PDF has more than one recipe. Which one?',
    back: 'Back to the document',
  },
};

const UPDATED_FORMAT = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/London',
});

// Choosing an import input and resuming imports in progress (DEC-108): pasted
// text, images uploaded straight to Cloudinary, a web link the server
// fetches (DEC-107), or a Document (DEC-111). A file dropped anywhere on the
// page is taken in every mode.
export function RecipeImportPage(): React.ReactElement {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const isOnline = useOnlineStatus();
  const startMutation = trpc.recipeImports.start.useMutation();
  const credentialsQuery =
    trpc.uploads.getRecipeImportImageCredentials.useQuery(undefined, {
      enabled: false,
    });
  const pdfCredentialsQuery =
    trpc.uploads.getRecipeImportPdfCredentials.useQuery(undefined, {
      enabled: false,
    });

  const [mode, setMode] = useState<ImportMode>('text');
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [imageProblems, setImageProblems] = useState<string[]>([]);
  const [doc, setDoc] = useState<ImportDocument | null>(null);
  const [docProblem, setDocProblem] = useState<string | null>(null);
  // The chosen images once uploaded, so trying again or picking one of
  // several recipes doesn't upload them again.
  const [uploadedIds, setUploadedIds] = useState<string[] | null>(null);
  // The same for a PDF, kept with the file it came from.
  const [uploadedPdf, setUploadedPdf] = useState<{
    file: File;
    publicId: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  // Set when the text holds several recipes: the input that was sent, so the
  // pick goes with the same one (DEC-103).
  const [several, setSeveral] = useState<{
    input: RecipeImportInput;
    names: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const working = uploading || startMutation.isPending;
  const trimmed = text.trim();
  const trimmedLink = link.trim();
  const docReady =
    doc !== null && (doc.kind !== 'text' || doc.text.trim() !== '');

  const dragging = useFileDrop(
    isOnline && !working && several === null,
    takeDrop,
  );

  function chooseMode(next: ImportMode): void {
    setMode(next);
    setError(null);
    setImageProblems([]);
    setDocProblem(null);
  }

  function changeFiles(next: File[]): void {
    setFiles(next);
    setUploadedIds(null);
    setError(null);
  }

  // A Document switches to Document mode, and images join the ones already
  // picked in Photos, through the picker's own checks.
  function takeDrop(dropped: File[]): void {
    const sorted = sortDroppedFiles(dropped);
    if (sorted === null) return;
    if (sorted.kind === 'refused') {
      setError(sorted.problem);
      return;
    }
    if (sorted.kind === 'document') {
      chooseMode('document');
      void takeDocument(sorted.file);
      return;
    }
    chooseMode('images');
    const added = addImportImages(files, sorted.files);
    setImageProblems(added.problems);
    if (added.files.length > files.length) changeFiles(added.files);
  }

  async function takeDocument(file: File): Promise<void> {
    const reading = await readImportDocument(file);
    if (!reading.ok) {
      setDocProblem(reading.problem);
      return;
    }
    setDocProblem(null);
    setError(null);
    setDoc(reading.document);
  }

  async function start(input: RecipeImportInput, pick?: string): Promise<void> {
    setError(null);
    try {
      const result = await startMutation.mutateAsync(
        pick === undefined ? { input } : { input, pick },
      );
      if (result.kind === 'several') {
        setSeveral({ input, names: result.names });
        return;
      }
      await utils.recipeImports.list.invalidate();
      await navigate({
        to: '/recipes/import/$draftId',
        params: { draftId: String(result.draftId) },
      });
    } catch (err) {
      setError(startErrorMessage(err, input.kind));
    }
  }

  async function importLink(): Promise<void> {
    const url = withScheme(trimmedLink);
    if (!URL.canParse(url)) {
      setError('That doesn’t look like a web link.');
      return;
    }
    await start({ kind: 'link', url });
  }

  async function importDocument(): Promise<void> {
    if (doc === null) return;
    if (doc.kind === 'pdf') {
      await importPdf(doc.file);
      return;
    }
    await start(
      doc.kind === 'text'
        ? { kind: 'text', text: doc.text.trim() }
        : { kind: 'html', fileName: doc.fileName, html: doc.html },
    );
  }

  // Straight to Cloudinary, never through the backend (DEC-50, DEC-111).
  async function importPdf(file: File): Promise<void> {
    setError(null);
    let publicId = uploadedPdf?.file === file ? uploadedPdf.publicId : null;
    if (publicId === null) {
      setUploading(true);
      try {
        const credentials = (await pdfCredentialsQuery.refetch()).data;
        if (!credentials) throw new Error('No upload credentials');
        publicId = (await uploadToCloudinary(file, credentials)).publicId;
        setUploadedPdf({ file, publicId });
      } catch {
        setError('Couldn’t upload the PDF. Try again.');
        return;
      } finally {
        setUploading(false);
      }
    }
    await start({ kind: 'pdf', publicId });
  }

  async function importImages(): Promise<void> {
    setError(null);
    let publicIds = uploadedIds;
    if (publicIds === null) {
      setUploading(true);
      try {
        const credentials = (await credentialsQuery.refetch()).data;
        if (!credentials) throw new Error('No upload credentials');
        const uploads = await Promise.all(
          files.map((file) => uploadToCloudinary(file, credentials)),
        );
        publicIds = uploads.map((upload) => upload.publicId);
        setUploadedIds(publicIds);
      } catch {
        setError('Couldn’t upload the images. Try again.');
        return;
      } finally {
        setUploading(false);
      }
    }
    await start({ kind: 'images', publicIds });
  }

  return (
    <section className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <p className="text-sm">
          <Link to="/recipes" className="text-muted-foreground hover:underline">
            ← Back to recipes
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Import a recipe</h1>
        <p className="text-sm text-muted-foreground">
          Paste a recipe, add photos of it, give a link to it or choose a file
          holding it, and it&rsquo;s turned into a draft for you to check.
          Nothing is added to your recipes until you create it.
        </p>
      </header>

      {several ? (
        <section className="space-y-3" aria-labelledby="import-several-heading">
          <h2 id="import-several-heading" className="text-lg font-semibold">
            {INPUT_WORDS[several.input.kind].several}
          </h2>
          <ul className="space-y-2">
            {several.names.map((name) => (
              <li key={name}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                  disabled={working || !isOnline}
                  onClick={() => {
                    void start(several.input, name);
                  }}
                >
                  {name}
                </Button>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="ghost"
            disabled={working}
            onClick={() => {
              setSeveral(null);
              setError(null);
            }}
          >
            {INPUT_WORDS[several.input.kind].back}
          </Button>
        </section>
      ) : (
        <div className="space-y-4">
          <div
            role="group"
            aria-label="Import from"
            className="inline-flex flex-wrap gap-1 rounded-md border border-input p-1"
          >
            {MODES.map((option) => (
              <Button
                key={option.mode}
                type="button"
                size="sm"
                variant={mode === option.mode ? 'secondary' : 'ghost'}
                aria-pressed={mode === option.mode}
                disabled={working}
                onClick={() => {
                  chooseMode(option.mode);
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
          {mode === 'text' ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (trimmed === '' || working || !isOnline) return;
                void start({ kind: 'text', text: trimmed });
              }}
            >
              <label htmlFor="import-text" className="text-sm font-medium">
                Recipe text
              </label>
              <textarea
                id="import-text"
                rows={12}
                maxLength={RECIPE_IMPORT_TEXT_MAX_LENGTH}
                placeholder="Paste the whole recipe: title, ingredients and method."
                disabled={working}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                }}
              />
              <div className="flex flex-wrap items-center justify-end gap-3">
                {!isOnline && (
                  <p className="text-sm text-muted-foreground">
                    You&rsquo;re offline. Importing needs a connection.
                  </p>
                )}
                <Button
                  type="submit"
                  disabled={trimmed === '' || working || !isOnline}
                >
                  Import
                </Button>
              </div>
            </form>
          ) : mode === 'link' ? (
            <form
              className="space-y-3"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (trimmedLink === '' || working || !isOnline) return;
                void importLink();
              }}
            >
              <label htmlFor="import-link" className="text-sm font-medium">
                Recipe link
              </label>
              <input
                id="import-link"
                type="url"
                inputMode="url"
                autoComplete="off"
                maxLength={RECIPE_IMPORT_LINK_MAX_LENGTH}
                placeholder="https://"
                disabled={working}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={link}
                onChange={(event) => {
                  setLink(event.target.value);
                }}
              />
              <div className="flex flex-wrap items-center justify-end gap-3">
                {!isOnline && (
                  <p className="text-sm text-muted-foreground">
                    You&rsquo;re offline. Importing needs a connection.
                  </p>
                )}
                <Button
                  type="submit"
                  disabled={trimmedLink === '' || working || !isOnline}
                >
                  Import
                </Button>
              </div>
            </form>
          ) : mode === 'document' ? (
            <form
              className="space-y-3"
              aria-label="Import from a document"
              onSubmit={(event) => {
                event.preventDefault();
                if (!docReady || working || !isOnline) return;
                void importDocument();
              }}
            >
              <DocumentPicker
                value={doc}
                problem={docProblem}
                disabled={working}
                onFile={(file) => {
                  void takeDocument(file);
                }}
                onTextChange={(next) => {
                  setDoc((current) =>
                    current?.kind === 'text'
                      ? { ...current, text: next }
                      : current,
                  );
                }}
                onRemove={() => {
                  setDoc(null);
                  setDocProblem(null);
                  setError(null);
                }}
              />
              <div className="flex flex-wrap items-center justify-end gap-3">
                {!isOnline && (
                  <p className="text-sm text-muted-foreground">
                    You&rsquo;re offline. Importing needs a connection.
                  </p>
                )}
                <Button
                  type="submit"
                  disabled={!docReady || working || !isOnline}
                >
                  Import
                </Button>
              </div>
            </form>
          ) : (
            <form
              className="space-y-3"
              aria-label="Import from images"
              onSubmit={(event) => {
                event.preventDefault();
                if (files.length === 0 || working || !isOnline) return;
                void importImages();
              }}
            >
              <ImportImagePicker
                files={files}
                onFilesChange={changeFiles}
                problems={imageProblems}
                onProblemsChange={setImageProblems}
                disabled={working}
              />
              <div className="flex flex-wrap items-center justify-end gap-3">
                {!isOnline && (
                  <p className="text-sm text-muted-foreground">
                    You&rsquo;re offline. Importing needs a connection.
                  </p>
                )}
                <Button
                  type="submit"
                  disabled={files.length === 0 || working || !isOnline}
                >
                  Import
                </Button>
              </div>
            </form>
          )}
        </div>
      )}

      {working && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {uploading
            ? mode === 'document'
              ? 'Uploading the PDF…'
              : 'Uploading the images…'
            : 'Reading the recipe… This can take up to a minute.'}
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <ImportsInProgress />

      {dragging && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
        >
          <div className="rounded-lg border-2 border-dashed border-primary bg-background px-8 py-12 text-center shadow-lg">
            <p className="text-lg font-semibold">Drop to import</p>
            <p className="text-sm text-muted-foreground">
              One document, or up to {RECIPE_IMPORT_IMAGES_MAX} photos
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function ImportsInProgress(): React.ReactElement | null {
  const utils = trpc.useUtils();
  const listQuery = trpc.recipeImports.list.useQuery();
  const discardMutation = trpc.recipeImports.discard.useMutation();

  if (listQuery.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Couldn&rsquo;t load your imports in progress.
      </p>
    );
  }
  const imports = listQuery.data ?? [];
  if (imports.length === 0) return null;

  async function discard(draftId: number): Promise<void> {
    await discardMutation.mutateAsync({ draftId });
    await utils.recipeImports.list.invalidate();
  }

  return (
    <section
      aria-labelledby="imports-in-progress-heading"
      className="space-y-3"
    >
      <h2 id="imports-in-progress-heading" className="text-lg font-semibold">
        Imports in progress
      </h2>
      <ul className="divide-y rounded-md border border-input">
        {imports.map((item) => (
          <ImportRow
            key={item.id}
            item={item}
            onDiscard={() => discard(item.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function ImportRow({
  item,
  onDiscard,
}: {
  item: RecipeImportDraftSummary;
  onDiscard: () => Promise<void>;
}): React.ReactElement {
  const name = item.name ?? 'Untitled import';
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="truncate font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">
          Last changed {UPDATED_FORMAT.format(new Date(item.lastUpdatedAt))}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <DiscardImportButton name={name} onConfirm={onDiscard} />
        <Button asChild>
          <Link
            to="/recipes/import/$draftId"
            params={{ draftId: String(item.id) }}
            aria-label={`Resume ${name}`}
          >
            Resume
          </Link>
        </Button>
      </div>
    </li>
  );
}

// A link typed without a scheme is taken as https.
function withScheme(link: string): string {
  return /^[a-z][a-z\d+.-]*:/i.test(link) ? link : `https://${link}`;
}

function startErrorMessage(err: unknown, kind: InputKind): string {
  const cause = getDomainErrorCause(err);
  switch (cause?.code) {
    case 'IMPORT_NOT_A_RECIPE':
      return kind === 'link' || kind === 'html'
        ? 'Couldn’t find a recipe in that. If the page has one, paste the text or a screenshot instead.'
        : 'Couldn’t find a recipe in that.';
    case 'IMPORT_LINK_NOT_ALLOWED':
      return 'That link can’t be imported. Use an https link to a public recipe page.';
    case 'IMPORT_LINK_UNREADABLE':
      return 'Couldn’t read that page. Paste the text or a screenshot instead.';
    case 'IMPORT_RATE_LIMITED':
      return 'You’ve reached the import limit. Try again in an hour.';
    case 'IMPORT_DOCUMENT_TOO_LONG': {
      const pageCount =
        typeof cause.pageCount === 'number' ? cause.pageCount : null;
      return pageCount === null
        ? `That PDF has more than ${String(RECIPE_IMPORT_PDF_PAGES_MAX)} pages. Save just the recipe’s pages as a PDF, or screenshot them.`
        : `That PDF has ${String(pageCount)} pages; the most is ${String(RECIPE_IMPORT_PDF_PAGES_MAX)}. Save just the recipe’s pages as a PDF, or screenshot them.`;
    }
    case 'IMPORT_REQUEST_REJECTED':
      return 'Importing isn’t working at the moment, and trying again won’t help. The problem has been reported.';
    default:
      return 'The import didn’t work. Try again.';
  }
}
