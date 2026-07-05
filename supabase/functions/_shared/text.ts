// #8 Display-layer address title-casing: SHOUTED all-caps address words
// ("LONDON" -> "London", "EARL'S COURT" -> "Earl's Court") become title case,
// while postcodes (uppercase runs adjacent to a digit, e.g. SW7, EC2A, 1AA),
// mixed-case and numeric tokens are left untouched. Stored data is never changed.
// Lookahead-only (no lookbehind) so it parses on older Safari too. A SHOUTED word
// is 2+ letters and may contain apostrophes, so possessives case correctly.
export function titleCaseAddress(s: string | null | undefined): string {
  if (!s) return s ?? "";
  return s.replace(/(^|[^A-Za-z0-9'])([A-Z][A-Z']*[A-Z])(?![A-Za-z0-9])/g, (_m, pre, word) => pre + word[0] + word.slice(1).toLowerCase());
}
