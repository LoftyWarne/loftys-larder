// The first `max` UTF-16 code units of `text`, without cutting an emoji or
// other astral character in half. Postgres refuses a lone surrogate in jsonb,
// so text cut to a cap and stored in a draft must not end in one.
export function takeChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
