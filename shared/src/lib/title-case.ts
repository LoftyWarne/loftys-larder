const LOWERCASE_WORDS = new Set(['and', 'or']);

// Upper-cases the first letter of each whitespace-separated word, skipping
// leading punctuation such as "(", and leaves the rest untouched so acronyms
// ("BBQ") survive. Connectives stay lower-case unless they open the name.
export function toTitleCase(value: string): string {
  let isFirstWord = true;
  return value
    .split(/(\s+)/)
    .map((token) => {
      if (token === '' || /^\s+$/.test(token)) return token;
      const bare = token.replace(/^\P{L}+|\P{L}+$/gu, '').toLowerCase();
      const keepLower = !isFirstWord && LOWERCASE_WORDS.has(bare);
      isFirstWord = false;
      if (keepLower) return token.toLowerCase();
      return token.replace(
        /^([^\p{L}\p{N}]*)(\p{Ll})/u,
        (_, prefix: string, letter: string) =>
          `${prefix}${letter.toUpperCase()}`,
      );
    })
    .join('');
}
