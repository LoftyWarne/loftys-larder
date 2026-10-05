import { describe, expect, it } from 'vitest';

import { findPageSourceLink } from '../src/lib/recipe-import/page-source-link.ts';

const CANONICAL = 'https://recipes.example/canonical';
const OG_URL = 'https://recipes.example/og';
const SAVED_FROM = 'https://recipes.example/saved';

function page({
  canonical,
  ogUrl,
  savedFrom,
}: {
  canonical?: string;
  ogUrl?: string;
  savedFrom?: string;
}): string {
  const comment =
    savedFrom === undefined
      ? ''
      : `<!-- saved from url=(${String(savedFrom.length).padStart(4, '0')})${savedFrom} -->`;
  const head = [
    canonical === undefined ? '' : `<link rel="canonical" href="${canonical}">`,
    ogUrl === undefined ? '' : `<meta property="og:url" content="${ogUrl}">`,
  ].join('');
  return `<!DOCTYPE html>${comment}<html><head>${head}</head><body><p>Soup</p></body></html>`;
}

describe('findPageSourceLink', () => {
  it('takes the canonical link first', () => {
    expect(
      findPageSourceLink(
        page({ canonical: CANONICAL, ogUrl: OG_URL, savedFrom: SAVED_FROM }),
      ),
    ).toBe(CANONICAL);
  });

  it('takes og:url when there is no canonical link', () => {
    expect(
      findPageSourceLink(page({ ogUrl: OG_URL, savedFrom: SAVED_FROM })),
    ).toBe(OG_URL);
  });

  it('takes the saved-from comment last', () => {
    expect(findPageSourceLink(page({ savedFrom: SAVED_FROM }))).toBe(
      SAVED_FROM,
    );
  });

  it('gives null when the page names no link', () => {
    expect(findPageSourceLink(page({}))).toBeNull();
  });

  it.each([
    ['an http link', 'http://recipes.example/soup'],
    ['a relative link', '/recipes/soup'],
    ['a protocol-relative link', '//recipes.example/soup'],
    ['a malformed link', 'https://'],
    ['a script link', 'javascript:alert(1)'],
    [
      'a link over 2,000 characters',
      `https://recipes.example/${'a'.repeat(2000)}`,
    ],
  ])('skips %s for the next one', (_label, link) => {
    expect(
      findPageSourceLink(page({ canonical: link, savedFrom: SAVED_FROM })),
    ).toBe(SAVED_FROM);
  });

  it('skips an http saved-from comment', () => {
    expect(
      findPageSourceLink(page({ savedFrom: 'http://recipes.example/soup' })),
    ).toBeNull();
  });

  it('reads rel and property values in any case, among other tokens', () => {
    expect(
      findPageSourceLink(
        `<html><head><link rel="Alternate CANONICAL" href="${CANONICAL}"></head></html>`,
      ),
    ).toBe(CANONICAL);
    expect(
      findPageSourceLink(
        `<html><head><meta name="OG:URL" content="${OG_URL}"></head></html>`,
      ),
    ).toBe(OG_URL);
  });

  it('decodes entities and trims the link', () => {
    expect(
      findPageSourceLink(
        '<link rel="canonical" href=" https://recipes.example/soup?a=1&amp;b=2 ">',
      ),
    ).toBe('https://recipes.example/soup?a=1&b=2');
  });

  it('ignores other comments', () => {
    expect(
      findPageSourceLink(
        `<!-- https://recipes.example/not-this --><html><body><!-- saved from url=(0029)${SAVED_FROM} --></body></html>`,
      ),
    ).toBe(SAVED_FROM);
  });
});
