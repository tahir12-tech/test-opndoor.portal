/* =====================================================================
   Display formatting helpers. Pure, display-layer only.
   ===================================================================== */

/**
 * #8 Title-case SHOUTED all-caps address data at the display layer only (stored
 * data is never changed). "LONDON" -> "London", "18 ONSLOW GARDENS" -> "18 Onslow
 * Gardens", while postcodes (uppercase runs adjacent to a digit, e.g. SW7, EC2A,
 * 1AA), mixed-case words and numbers are left untouched.
 */
export function titleCaseAddress(s: string | null | undefined): string {
  if (!s) return s ?? '';
  // Lookahead-only (no lookbehind, which older Safari cannot parse — this runs in
  // the browser). Match a SHOUTED word of 2+ letters (apostrophes allowed inside,
  // so possessives like EARL'S / KING'S / ST JOHN'S title-case to Earl's / King's /
  // St John's) preceded by a non-alphanumeric boundary and not followed by one, so
  // postcodes (SW7, EC2A, 1AA) and mixed-case names stay untouched.
  return s.replace(/(^|[^A-Za-z0-9'])([A-Z][A-Z']*[A-Z])(?![A-Za-z0-9])/g, (_m, pre, word) => pre + word[0] + word.slice(1).toLowerCase());
}
