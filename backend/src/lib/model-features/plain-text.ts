// Model output is plain text by the time it reaches the database or a page
// (DEC-49). Removes the markdown a model reaches for by habit; everything
// else is left as written, so "2 * 3" or "snake_case" survive.

const LINE_RULES: readonly [RegExp, string][] = [
  // Code fences and horizontal rules.
  [/^\s*(```|~~~).*$/gm, ''],
  [/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, ''],
  // Headings, block quotes and bullet markers.
  [/^\s{0,3}#{1,6}\s+/gm, ''],
  [/^\s{0,3}>\s?/gm, ''],
  [/^(\s*)[-*+]\s+/gm, '$1'],
];

const INLINE_RULES: readonly [RegExp, string][] = [
  // Images, then links: keep the visible text.
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]+)\]\([^)]*\)/g, '$1'],
  // Bold, then italic. Each needs non-space text right inside the markers.
  [/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1'],
  [/__(?=\S)(.+?)(?<=\S)__/g, '$1'],
  [/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1$2'],
  [/(^|[^\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/g, '$1$2'],
  // Inline code.
  [/`([^`\n]+)`/g, '$1'],
];

export function stripMarkdown(text: string): string {
  let result = text;
  for (const [pattern, replacement] of [...LINE_RULES, ...INLINE_RULES]) {
    result = result.replace(pattern, replacement);
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
