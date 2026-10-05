import { DomUtils, ElementType, parseDocument } from 'htmlparser2';

import {
  RECIPE_IMPORT_TEXT_MAX_LENGTH,
  takeChars,
} from '../../../../shared/src/index.ts';
import type { RecipeReaderPageContent } from '../recipe-reader/types.ts';

// What a fetched page gives the reader (DEC-107): its schema.org `Recipe`
// JSON-LD when it has some, otherwise its readable text. Either way the
// content is capped like pasted text, and it's untrusted input (DEC-104).

export const PAGE_CONTENT_MAX_LENGTH = RECIPE_IMPORT_TEXT_MAX_LENGTH;

const JSON_LD_RECIPES_MAX = 10;
const JSON_LD_DEPTH_MAX = 12;

// What the reader needs from a Recipe and the objects inside it (steps,
// sections, nutrition, author). Reviews, ratings, images and video go.
const JSON_LD_KEYS = new Set([
  '@type',
  'name',
  'text',
  'description',
  'recipeYield',
  'yield',
  'prepTime',
  'cookTime',
  'performTime',
  'totalTime',
  'recipeIngredient',
  'ingredients',
  'recipeInstructions',
  'itemListElement',
  'nutrition',
  'servingSize',
  'calories',
  'proteinContent',
  'carbohydrateContent',
  'fatContent',
  'saturatedFatContent',
  'fiberContent',
  'sugarContent',
  'sodiumContent',
  'recipeCategory',
  'recipeCuisine',
  'keywords',
  'suitableForDiet',
  'author',
  'publisher',
]);

const DROPPED_TAGS = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'object',
  'embed',
  'canvas',
  'video',
  'audio',
  'nav',
  'aside',
  'form',
  'button',
  'select',
  'dialog',
]);

// Site chrome, unless it sits inside the page's main content.
const CHROME_TAGS = new Set(['header', 'footer']);
const CONTENT_TAGS = new Set(['main', 'article']);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

type HtmlElement = ReturnType<typeof DomUtils.findAll>[number];
type HtmlNode = HtmlElement['children'][number];

export function readPageContent(html: string): RecipeReaderPageContent {
  const document = parseDocument(html);
  const recipes = jsonLdRecipes(document.children);
  if (recipes.length > 0) {
    return capped('json_ld', JSON.stringify(recipes));
  }
  return capped('text', pageText(document.children));
}

// The page's readable text, capped, even when the reader is sent its JSON-LD.
// Import Review shows it beside a saved page's proposal.
export function readPageText(html: string): string {
  return takeChars(
    pageText(parseDocument(html).children),
    PAGE_CONTENT_MAX_LENGTH,
  );
}

function capped(
  format: RecipeReaderPageContent['format'],
  content: string,
): RecipeReaderPageContent {
  return content.length > PAGE_CONTENT_MAX_LENGTH
    ? {
        format,
        content: takeChars(content, PAGE_CONTENT_MAX_LENGTH),
        truncated: true,
      }
    : { format, content, truncated: false };
}

// --- JSON-LD -----------------------------------------------------------------

function jsonLdRecipes(nodes: HtmlNode[]): unknown[] {
  const scripts = DomUtils.findAll(
    (element) =>
      element.name === 'script' &&
      (element.attribs.type ?? '').split(';')[0]?.trim().toLowerCase() ===
        'application/ld+json',
    nodes,
  );
  const found: Record<string, unknown>[] = [];
  for (const script of scripts) {
    const data = parseJsonLd(DomUtils.textContent(script));
    if (data !== undefined) collectRecipes(data, found, 0);
  }
  const recipes = new Map<string, unknown>();
  for (const recipe of found) {
    const pruned = pruneJsonLd(recipe, 0);
    if (pruned !== undefined) recipes.set(JSON.stringify(pruned), pruned);
    if (recipes.size === JSON_LD_RECIPES_MAX) break;
  }
  return [...recipes.values()];
}

function parseJsonLd(text: string): unknown {
  try {
    // Raw control characters, such as line breaks inside strings, are
    // common and make JSON.parse fail. Outside strings they're whitespace.
    return JSON.parse(
      Array.from(text, (char) => (char < ' ' ? ' ' : char)).join(''),
    );
  } catch {
    return undefined;
  }
}

// A Recipe can sit in an array, in `@graph`, or deeper (`mainEntity`, an
// `ItemList`), and its `@type` can be an array.
function collectRecipes(
  value: unknown,
  found: Record<string, unknown>[],
  depth: number,
): void {
  if (depth > JSON_LD_DEPTH_MAX) return;
  if (Array.isArray(value)) {
    for (const item of value) collectRecipes(item, found, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  if (isRecipeType(value['@type'])) {
    if (hasRecipeContent(value)) found.push(value);
    return;
  }
  for (const child of Object.values(value)) {
    collectRecipes(child, found, depth + 1);
  }
}

function isRecipeType(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some(
    (item) =>
      typeof item === 'string' &&
      (item === 'Recipe' ||
        item.endsWith('/Recipe') ||
        item.endsWith(':Recipe')),
  );
}

// A Recipe with no ingredients or method (only a name and an image, say)
// gives the reader less than the page's text does.
function hasRecipeContent(recipe: Record<string, unknown>): boolean {
  return [
    recipe.recipeIngredient,
    recipe.ingredients,
    recipe.recipeInstructions,
  ].some(
    (value) =>
      (typeof value === 'string' && value.trim() !== '') ||
      (Array.isArray(value) && value.length > 0) ||
      isObject(value),
  );
}

function pruneJsonLd(value: unknown, depth: number): unknown {
  if (depth > JSON_LD_DEPTH_MAX) return undefined;
  if (typeof value === 'string') {
    const text = htmlToPlainText(value);
    return text === '' ? undefined : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => pruneJsonLd(item, depth + 1))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, child]) => {
    if (!JSON_LD_KEYS.has(key)) return [];
    const pruned = pruneJsonLd(child, depth + 1);
    return pruned === undefined ? [] : [[key, pruned] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// JSON-LD strings often carry HTML entities ("&#8217;", "&frac12;") and
// sometimes tags.
function htmlToPlainText(value: string): string {
  const text = /[&<]/.test(value)
    ? textOf(parseDocument(value).children, true)
    : value;
  return text.replace(/\s+/g, ' ').trim();
}

// --- Text fallback -----------------------------------------------------------

// The page's main content when it marks one, else its body, with scripts,
// styles, navigation and site chrome left out.
function pageText(nodes: HtmlNode[]): string {
  const main = DomUtils.findOne((element) => element.name === 'main', nodes);
  const articles = main
    ? []
    : DomUtils.findAll((element) => element.name === 'article', nodes);
  const content: HtmlNode[] = main
    ? [main]
    : articles.length > 0
      ? DomUtils.removeSubsets(articles)
      : nodes;
  const text = textOf(content, content !== nodes);
  const title = DomUtils.findOne((element) => element.name === 'title', nodes);
  const heading = title ? DomUtils.textContent(title).trim() : '';
  return normaliseText(
    content !== nodes && heading !== '' ? `${heading}\n${text}` : text,
  );
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'attribs' in node;
}

function textOf(nodes: readonly HtmlNode[], inContent: boolean): string {
  const out: string[] = [];
  appendText(nodes, out, inContent);
  return out.join('');
}

function appendText(
  nodes: readonly HtmlNode[],
  out: string[],
  inContent: boolean,
): void {
  for (const node of nodes) {
    if (node.type === ElementType.Text) {
      out.push(node.data);
      continue;
    }
    if (!isElement(node)) {
      if (node.type === ElementType.Root) {
        appendText(node.children, out, inContent);
      }
      continue;
    }
    if (isDropped(node, inContent)) continue;
    const block = BLOCK_TAGS.has(node.name);
    if (block) out.push('\n');
    appendText(node.children, out, inContent || CONTENT_TAGS.has(node.name));
    if (block) out.push('\n');
  }
}

function isDropped(element: HtmlElement, inContent: boolean): boolean {
  return (
    DROPPED_TAGS.has(element.name) ||
    (CHROME_TAGS.has(element.name) && !inContent) ||
    element.attribs.hidden !== undefined ||
    element.attribs.role === 'navigation'
  );
}

function normaliseText(text: string): string {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n\s*/g, '\n')
    .trim();
}
