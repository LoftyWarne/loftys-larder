import {
  RECIPE_IMPORT_DOCUMENT_EXTENSIONS,
  RECIPE_IMPORT_DOCUMENT_MAX_FILE_SIZE,
  RECIPE_IMPORT_FILE_NAME_MAX_LENGTH,
  RECIPE_IMPORT_HTML_MAX_LENGTH,
  RECIPE_IMPORT_HTML_MAX_REQUEST_BYTES,
  RECIPE_IMPORT_IMAGE_ALLOWED_FORMATS,
  RECIPE_IMPORT_IMAGES_MAX,
  RECIPE_IMPORT_TEXT_MAX_LENGTH,
  type RecipeImportDocumentKind,
  takeChars,
} from '@loftys-larder/shared';

// Documents (DEC-111), read in the browser. A text or Markdown file loads
// into a text box and imports as pasted text. A saved web page is pruned
// here, so the backend never receives the file as it was saved. A PDF is
// checked here and uploaded to Cloudinary on Import.

export const DOCUMENT_REFUSED =
  'That file can’t be imported. Use a PDF, text, Markdown or web page (.html) file.';
export const DOCUMENT_TOO_BIG = 'That file is too big to import.';
export const DOCUMENT_UNREADABLE = 'Couldn’t read that file. Try again.';
export const PAGE_TOO_BIG =
  'That page is too big to import. Paste the recipe’s text instead.';
export const PDF_PASSWORD_PROTECTED =
  'That PDF is password-protected. Save an unlocked copy, or screenshot the recipe.';
export const DROP_ONE_DOCUMENT = `Drop one document, or up to ${String(RECIPE_IMPORT_IMAGES_MAX)} photos.`;

export const DOCUMENT_ACCEPT = [
  ...Object.keys(RECIPE_IMPORT_DOCUMENT_EXTENSIONS).map(
    (extension) => `.${extension}`,
  ),
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/html',
].join(',');

const KIND_BY_EXTENSION = new Map<string, RecipeImportDocumentKind>(
  Object.entries(RECIPE_IMPORT_DOCUMENT_EXTENSIONS),
);

const KIND_BY_TYPE = new Map<string, RecipeImportDocumentKind>([
  ['application/pdf', 'pdf'],
  ['text/plain', 'text'],
  ['text/markdown', 'text'],
  ['text/x-markdown', 'text'],
  ['text/html', 'html'],
  ['application/xhtml+xml', 'html'],
]);

const IMAGE_EXTENSIONS = new Set<string>(RECIPE_IMPORT_IMAGE_ALLOWED_FORMATS);

export type ImportDocument =
  | {
      kind: 'text';
      fileName: string;
      size: number;
      text: string;
      // Longer than the paste limit, so only its start was loaded.
      truncated: boolean;
    }
  | { kind: 'html'; fileName: string; size: number; html: string }
  // Uploaded as it is when the cook presses Import.
  | { kind: 'pdf'; fileName: string; size: number; file: File };

export type ImportDocumentReading =
  | { ok: true; document: ImportDocument }
  | { ok: false; problem: string };

export function formatFileSize(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function extensionOf(name: string): string | null {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot === -1) return null;
  const extension = trimmed.slice(dot + 1).toLowerCase();
  return extension === '' ? null : extension;
}

// By extension, because phones often give a Markdown file the type
// application/octet-stream or none at all. The type counts only for a file
// with no extension.
export function documentKind(
  file: Pick<File, 'name' | 'type'>,
): RecipeImportDocumentKind | null {
  const extension = extensionOf(file.name);
  if (extension !== null) return KIND_BY_EXTENSION.get(extension) ?? null;
  const type = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  return KIND_BY_TYPE.get(type) ?? null;
}

function looksLikeImage(file: Pick<File, 'name' | 'type'>): boolean {
  const extension = extensionOf(file.name);
  return (
    file.type.startsWith('image/') ||
    (extension !== null && IMAGE_EXTENSIONS.has(extension))
  );
}

export type DroppedFiles =
  | { kind: 'document'; file: File }
  // Checked by the Photos picker, which refuses any that aren't images.
  | { kind: 'images'; files: File[] }
  | { kind: 'refused'; problem: string };

// One Document, or photos: never both, and never two Documents.
export function sortDroppedFiles(files: readonly File[]): DroppedFiles | null {
  const [first] = files;
  if (!first) return null;
  const documents = files.filter((file) => documentKind(file) !== null);
  if (documents.length > 0) {
    return files.length === 1
      ? { kind: 'document', file: first }
      : { kind: 'refused', problem: DROP_ONE_DOCUMENT };
  }
  if (files.some(looksLikeImage)) return { kind: 'images', files: [...files] };
  return {
    kind: 'refused',
    problem: files.length === 1 ? DOCUMENT_REFUSED : DROP_ONE_DOCUMENT,
  };
}

const BOMS: { bytes: readonly number[]; encoding: string }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

function bomOf(bytes: Uint8Array): (typeof BOMS)[number] | null {
  return (
    BOMS.find((bom) => bom.bytes.every((byte, at) => bytes[at] === byte)) ??
    null
  );
}

// UTF-8, or Windows-1252 for a file that isn't valid UTF-8, so "£" and "½"
// from an older editor come through. Line endings become "\n".
export function decodeText(bytes: Uint8Array): string {
  const bom = bomOf(bytes);
  const body = bom ? bytes.subarray(bom.bytes.length) : bytes;
  let text: string;
  if (bom && bom.encoding !== 'utf-8') {
    text = new TextDecoder(bom.encoding).decode(body);
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      text = new TextDecoder('windows-1252').decode(body);
    }
  }
  return text.replace(/\r\n?/g, '\n');
}

const META_CHARSET = /<meta\b[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i;

// A BOM if there is one, otherwise the charset a `<meta>` names in the first
// 1,024 bytes, otherwise UTF-8.
export function htmlEncoding(bytes: Uint8Array): string {
  const bom = bomOf(bytes);
  if (bom) return bom.encoding;
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1024));
  const label = META_CHARSET.exec(head)?.[1];
  if (label === undefined) return 'utf-8';
  let encoding: string;
  try {
    encoding = new TextDecoder(label).encoding;
  } catch {
    return 'utf-8';
  }
  // Markup that could name its charset in ASCII isn't UTF-16, whatever the
  // tag says.
  return encoding.startsWith('utf-16') ? 'utf-8' : encoding;
}

export function decodeHtml(bytes: Uint8Array): string {
  return new TextDecoder(htmlEncoding(bytes)).decode(bytes);
}

const SAVED_FROM = 'saved from url=';

function isJsonLd(script: Element): boolean {
  const type = script.getAttribute('type') ?? '';
  return type.split(';')[0]?.trim().toLowerCase() === 'application/ld+json';
}

// Keeps what the server reads: `<head>` (for the canonical link, og:url and
// JSON-LD), the JSON-LD and the page's text. Scripts, styles and anything
// else that only weighs the page down go, as do comments other than the
// "saved from url" one browsers write when saving. A parsed document runs
// no scripts and loads nothing.
export function pruneHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const element of parsed.querySelectorAll(
    'script, style, svg, noscript, iframe, template',
  )) {
    if (element.localName === 'script' && isJsonLd(element)) continue;
    element.remove();
  }
  const walker = parsed.createTreeWalker(parsed, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    comments.push(node as Comment);
  }
  for (const comment of comments) {
    if (!comment.data.trimStart().toLowerCase().startsWith(SAVED_FROM)) {
      comment.remove();
    }
  }
  // The whole document, including a comment before `<html>`, which the
  // root element's own markup leaves out.
  return Array.from(parsed.childNodes, (node) => {
    if (node.nodeType === Node.COMMENT_NODE) {
      return `<!--${(node as Comment).data}-->`;
    }
    if (node.nodeType === Node.DOCUMENT_TYPE_NODE) {
      return `<!DOCTYPE ${(node as DocumentType).name}>`;
    }
    if (node.nodeType === Node.ELEMENT_NODE) return (node as Element).outerHTML;
    return '';
  }).join('');
}

// The server's cap on the markup, and what fits well inside Fastify's body
// limit once it's sent as JSON.
export function htmlFitsCaps(html: string): boolean {
  return (
    html.length <= RECIPE_IMPORT_HTML_MAX_LENGTH &&
    new TextEncoder().encode(JSON.stringify(html)).length <=
      RECIPE_IMPORT_HTML_MAX_REQUEST_BYTES
  );
}

function documentFileName(name: string): string {
  const trimmed = takeChars(name.trim(), RECIPE_IMPORT_FILE_NAME_MAX_LENGTH);
  return trimmed.trim() === '' ? 'Untitled document' : trimmed;
}

// Where an encrypted PDF names its encryption: the trailer near the end, or
// the first-page trailer near the start of a linearised file.
const PDF_TRAILER_BYTES = 2048;
const PDF_ENCRYPT = /\/Encrypt(?![A-Za-z])/;

// A courtesy, not a guarantee: a PDF that gets past this is refused by the
// reader instead.
export async function pdfIsEncrypted(file: Blob): Promise<boolean> {
  const [head, tail] = await Promise.all([
    file.slice(0, PDF_TRAILER_BYTES).arrayBuffer(),
    file.slice(Math.max(0, file.size - PDF_TRAILER_BYTES)).arrayBuffer(),
  ]);
  const latin1 = new TextDecoder('windows-1252');
  return (
    PDF_ENCRYPT.test(latin1.decode(head)) ||
    PDF_ENCRYPT.test(latin1.decode(tail))
  );
}

export async function readImportDocument(
  file: File,
): Promise<ImportDocumentReading> {
  const kind = documentKind(file);
  if (kind === null) return { ok: false, problem: DOCUMENT_REFUSED };
  if (file.size > RECIPE_IMPORT_DOCUMENT_MAX_FILE_SIZE) {
    return { ok: false, problem: DOCUMENT_TOO_BIG };
  }
  const fileName = documentFileName(file.name);
  if (kind === 'pdf') {
    let encrypted: boolean;
    try {
      encrypted = await pdfIsEncrypted(file);
    } catch {
      return { ok: false, problem: DOCUMENT_UNREADABLE };
    }
    if (encrypted) return { ok: false, problem: PDF_PASSWORD_PROTECTED };
    return { ok: true, document: { kind, fileName, size: file.size, file } };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, problem: DOCUMENT_UNREADABLE };
  }
  if (kind === 'text') {
    const text = decodeText(bytes);
    return {
      ok: true,
      document: {
        kind,
        fileName,
        size: file.size,
        text: takeChars(text, RECIPE_IMPORT_TEXT_MAX_LENGTH),
        truncated: text.length > RECIPE_IMPORT_TEXT_MAX_LENGTH,
      },
    };
  }
  const html = pruneHtml(decodeHtml(bytes));
  if (!htmlFitsCaps(html)) return { ok: false, problem: PAGE_TOO_BIG };
  return { ok: true, document: { kind, fileName, size: file.size, html } };
}
