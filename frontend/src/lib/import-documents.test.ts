import {
  RECIPE_IMPORT_DOCUMENT_MAX_FILE_SIZE,
  RECIPE_IMPORT_HTML_MAX_LENGTH,
} from '@loftys-larder/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  decodeHtml,
  decodeText,
  DOCUMENT_REFUSED,
  DOCUMENT_TOO_BIG,
  documentKind,
  DROP_ONE_DOCUMENT,
  htmlEncoding,
  htmlFitsCaps,
  PAGE_TOO_BIG,
  pruneHtml,
  readImportDocument,
  sortDroppedFiles,
} from './import-documents.ts';

function file(name: string, type = '', content: BlobPart = 'x'): File {
  return new File([content], name, { type });
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('documentKind', () => {
  it.each([
    ['recipe.txt', '', 'text'],
    ['recipe.text', '', 'text'],
    ['recipe.md', 'application/octet-stream', 'text'],
    ['RECIPE.MARKDOWN', '', 'text'],
    ['recipe.html', 'text/html', 'html'],
    ['recipe.htm', '', 'html'],
  ] as const)('sorts %s by its extension', (name, type, kind) => {
    expect(documentKind(file(name, type))).toBe(kind);
  });

  it.each([
    ['recipe.pdf', 'application/pdf'],
    ['recipe.docx', 'text/plain'],
    ['recipe.rtf', 'text/rtf'],
  ])('refuses %s, whatever its type', (name, type) => {
    expect(documentKind(file(name, type))).toBeNull();
  });

  it.each([
    ['text/plain', 'text'],
    ['text/markdown', 'text'],
    ['text/html; charset=utf-8', 'html'],
    ['application/xhtml+xml', 'html'],
    ['', null],
    ['application/octet-stream', null],
  ] as const)(
    'sorts a file with no extension by its type, %s',
    (type, kind) => {
      expect(documentKind(file('recipe', type))).toBe(kind);
      expect(documentKind(file('recipe.', type))).toBe(kind);
    },
  );
});

describe('sortDroppedFiles', () => {
  const page = file('soup.html', 'text/html');
  const notes = file('soup.md');
  const photo = file('soup.jpg', 'image/jpeg');
  const heic = file('IMG_0001.HEIC');
  const word = file('soup.docx', 'application/msword');

  it('takes one Document', () => {
    expect(sortDroppedFiles([page])).toEqual({ kind: 'document', file: page });
  });

  it('takes images, with anything else among them, for the Photos checks', () => {
    expect(sortDroppedFiles([photo, heic, word])).toEqual({
      kind: 'images',
      files: [photo, heic, word],
    });
  });

  it.each([
    ['two Documents', [page, notes]],
    ['a Document with images', [notes, photo]],
    ['a Document with another file', [page, word]],
    ['several files that are neither', [word, file('soup.pdf')]],
  ])('refuses %s', (_label, files) => {
    expect(sortDroppedFiles(files)).toEqual({
      kind: 'refused',
      problem: DROP_ONE_DOCUMENT,
    });
  });

  it('refuses one file that is neither', () => {
    expect(sortDroppedFiles([word])).toEqual({
      kind: 'refused',
      problem: DOCUMENT_REFUSED,
    });
  });

  it('takes nothing from an empty drop', () => {
    expect(sortDroppedFiles([])).toBeNull();
  });
});

describe('decodeText', () => {
  it('reads UTF-8, without its BOM', () => {
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, ...ascii('Soup £3 ½')))).toBe(
      'Soup £3 ½',
    );
  });

  it('reads a file that isn’t valid UTF-8 as Windows-1252', () => {
    // "£3 ½ cup" as an older Windows editor saves it.
    expect(
      decodeText(bytes(0xa3, 0x33, 0x20, 0xbd, 0x20, ...ascii('cup'))),
    ).toBe('£3 ½ cup');
  });

  it('reads UTF-16 with a BOM', () => {
    expect(decodeText(bytes(0xff, 0xfe, 0x53, 0x00, 0xa3, 0x00))).toBe('S£');
  });

  it('makes every line end in a newline', () => {
    expect(decodeText(ascii('Soup\r\nStew\rPie\n'))).toBe('Soup\nStew\nPie\n');
  });
});

describe('htmlEncoding', () => {
  it('goes by a BOM first', () => {
    expect(
      htmlEncoding(
        bytes(0xef, 0xbb, 0xbf, ...ascii('<meta charset="iso-8859-1">')),
      ),
    ).toBe('utf-8');
  });

  it.each([
    ['<meta charset="iso-8859-1">', 'windows-1252'],
    ["<meta charset='Shift_JIS'>", 'shift_jis'],
    [
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">',
      'windows-1252',
    ],
    ['<meta charset="not-a-charset">', 'utf-8'],
    ['<meta charset="utf-16">', 'utf-8'],
    ['<p>No charset</p>', 'utf-8'],
  ])('reads %s', (head, encoding) => {
    expect(htmlEncoding(ascii(`<html><head>${head}</head></html>`))).toBe(
      encoding,
    );
  });

  it('looks only in the first 1,024 bytes', () => {
    expect(
      htmlEncoding(ascii(`${' '.repeat(1024)}<meta charset="windows-1252">`)),
    ).toBe('utf-8');
  });
});

describe('decodeHtml', () => {
  it('decodes a page in the charset it names', () => {
    expect(
      decodeHtml(bytes(...ascii('<meta charset="windows-1252"><p>'), 0xa3)),
    ).toBe('<meta charset="windows-1252"><p>£');
  });
});

describe('pruneHtml', () => {
  const SAVED = `<!DOCTYPE html>
<!-- saved from url=(0035)https://recipes.example/shakshuka -->
<html><head>
<title>Shakshuka</title>
<link rel="canonical" href="https://recipes.example/shakshuka">
<meta property="og:url" content="https://recipes.example/shakshuka">
<script type="application/ld+json">{"@type":"Recipe","name":"Shakshuka"}</script>
<script>window.tracking = true;</script>
<script type="module" src="/app.js"></script>
<style>body { color: red; }</style>
</head><body>
<!-- ad slot -->
<svg><path d="M0 0"></path></svg>
<noscript>Enable JavaScript</noscript>
<iframe src="https://ads.example/"></iframe>
<template><p>Template</p></template>
<main><h1>Shakshuka</h1><p>Simmer the eggs.</p></main>
</body></html>`;

  it('keeps the head, JSON-LD, the saved-from comment and the text', () => {
    const pruned = pruneHtml(SAVED);

    expect(pruned).toMatch(
      /^<!DOCTYPE html><!-- saved from url=\(0035\)https:\/\/recipes\.example\/shakshuka --><html>/,
    );
    expect(pruned).toContain('<title>Shakshuka</title>');
    expect(pruned).toContain(
      '<link rel="canonical" href="https://recipes.example/shakshuka">',
    );
    expect(pruned).toContain(
      '<meta property="og:url" content="https://recipes.example/shakshuka">',
    );
    expect(pruned).toContain(
      '<script type="application/ld+json">{"@type":"Recipe","name":"Shakshuka"}</script>',
    );
    expect(pruned).toContain(
      '<main><h1>Shakshuka</h1><p>Simmer the eggs.</p></main>',
    );
  });

  it('removes other scripts, styles, SVG, noscript, iframes, templates and comments', () => {
    const pruned = pruneHtml(SAVED);

    for (const removed of [
      'tracking',
      'app.js',
      '<style',
      'color: red',
      '<svg',
      'Enable JavaScript',
      '<iframe',
      'Template',
      'ad slot',
    ]) {
      expect(pruned).not.toContain(removed);
    }
  });

  it('keeps a JSON-LD script whose type has parameters or capitals', () => {
    expect(
      pruneHtml(
        '<script type="Application/LD+JSON; charset=utf-8">{"@type":"Recipe"}</script>',
      ),
    ).toContain('{"@type":"Recipe"}');
  });
});

describe('htmlFitsCaps', () => {
  it('takes markup within both caps', () => {
    expect(htmlFitsCaps('a'.repeat(RECIPE_IMPORT_HTML_MAX_LENGTH))).toBe(true);
  });

  it('refuses markup over the server’s character cap', () => {
    expect(htmlFitsCaps('a'.repeat(RECIPE_IMPORT_HTML_MAX_LENGTH + 1))).toBe(
      false,
    );
  });

  it('refuses markup that would be too big once sent', () => {
    // Each "£" is two bytes in UTF-8, and each quote is escaped in JSON.
    expect(htmlFitsCaps('£'.repeat(460_000))).toBe(false);
    expect(htmlFitsCaps('"'.repeat(460_000))).toBe(false);
  });
});

describe('readImportDocument', () => {
  it('loads a text file', async () => {
    const reading = await readImportDocument(
      file(' Soup.md ', '', 'Soup\r\n200 g lentils'),
    );
    expect(reading).toEqual({
      ok: true,
      document: {
        kind: 'text',
        fileName: 'Soup.md',
        size: 19,
        text: 'Soup\n200 g lentils',
        truncated: false,
      },
    });
  });

  it('loads only the first 20,000 characters of a long text file, without splitting a character', async () => {
    const reading = await readImportDocument(
      file('long.txt', '', `${'a'.repeat(19_999)}😀 and more`),
    );
    expect(reading.ok && reading.document).toMatchObject({
      kind: 'text',
      text: 'a'.repeat(19_999),
      truncated: true,
    });
  });

  it('prunes a saved web page', async () => {
    const saved = file(
      'Soup.html',
      'text/html',
      '<html><head><script>track()</script></head><body><p>Soup</p></body></html>',
    );
    const reading = await readImportDocument(saved);
    expect(reading).toEqual({
      ok: true,
      document: {
        kind: 'html',
        fileName: 'Soup.html',
        size: saved.size,
        html: '<html><head></head><body><p>Soup</p></body></html>',
      },
    });
  });

  it('refuses a file it can’t import', async () => {
    expect(await readImportDocument(file('soup.pdf'))).toEqual({
      ok: false,
      problem: DOCUMENT_REFUSED,
    });
  });

  it('refuses a file over 10 MB without reading it', async () => {
    const big = file('soup.txt');
    Object.defineProperty(big, 'size', {
      value: RECIPE_IMPORT_DOCUMENT_MAX_FILE_SIZE + 1,
    });
    const read = vi.spyOn(big, 'arrayBuffer');

    expect(await readImportDocument(big)).toEqual({
      ok: false,
      problem: DOCUMENT_TOO_BIG,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a page still too big once pruned', async () => {
    const reading = await readImportDocument(
      file(
        'huge.html',
        'text/html',
        `<html><body><p>${'a'.repeat(RECIPE_IMPORT_HTML_MAX_LENGTH)}</p></body></html>`,
      ),
    );
    expect(reading).toEqual({ ok: false, problem: PAGE_TOO_BIG });
  });
});
