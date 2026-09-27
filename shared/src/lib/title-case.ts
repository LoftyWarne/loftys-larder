// Upper-cases the first letter of each whitespace-separated word and leaves
// the rest untouched, so acronyms ("BBQ") and mixed case ("iPhone") survive.
export function toTitleCase(value: string): string {
  return value.replace(
    /(^|\s)(\p{Ll})/gu,
    (_, boundary: string, letter: string) =>
      `${boundary}${letter.toUpperCase()}`,
  );
}
