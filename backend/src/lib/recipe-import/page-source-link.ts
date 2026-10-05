import { DomUtils, ElementType, parseDocument } from 'htmlparser2';

import { recipeImportSourceLinkSchema } from '../../../../shared/src/index.ts';

// The address a saved web page names as its own (DEC-111): its canonical
// link, otherwise its `og:url`, otherwise the "saved from url" comment a
// browser writes when saving it, taking the first that's an https link. The
// page is untrusted, and the link is stored but never fetched.

type HtmlNode = ReturnType<typeof parseDocument>['children'][number];

// Browsers write `<!-- saved from url=(0042)https://… -->`, the number being
// the address's length.
const SAVED_FROM = /^\s*saved from url=\(\d+\)(\S+)/i;

export function findPageSourceLink(html: string): string | null {
  const nodes = parseDocument(html).children;
  const candidates = [
    ...DomUtils.findAll(
      (element) =>
        element.name === 'link' && hasToken(element.attribs.rel, 'canonical'),
      nodes,
    ).map((element) => element.attribs.href),
    ...DomUtils.findAll(
      (element) =>
        element.name === 'meta' &&
        (element.attribs.property ?? element.attribs.name ?? '')
          .trim()
          .toLowerCase() === 'og:url',
      nodes,
    ).map((element) => element.attribs.content),
    ...savedFromLinks(nodes),
  ];
  for (const candidate of candidates) {
    const link = httpsLink(candidate);
    if (link !== null) return link;
  }
  return null;
}

function hasToken(value: string | undefined, token: string): boolean {
  return (value ?? '')
    .toLowerCase()
    .split(/\s+/)
    .some((part) => part === token);
}

function savedFromLinks(nodes: readonly HtmlNode[]): string[] {
  const links: string[] = [];
  const visit = (children: readonly HtmlNode[]) => {
    for (const node of children) {
      if (node.type === ElementType.Comment) {
        const match = SAVED_FROM.exec(node.data);
        if (match?.[1]) links.push(match[1]);
      } else if ('children' in node) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return links;
}

// A relative link has no page address to resolve against, so it's skipped.
function httpsLink(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!URL.canParse(trimmed)) return null;
  const parsed = recipeImportSourceLinkSchema.safeParse(new URL(trimmed).href);
  return parsed.success ? parsed.data : null;
}
