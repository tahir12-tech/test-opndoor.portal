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

/**
 * Format a commission rate (a fraction, 0–1) as a percentage to ONE decimal place.
 * NEVER rounds to a whole percent: a stored 9.5% (0.095) must render as "9.5%" and
 * can never be shown as — or mistaken for — 10% (0.10). 0.095 -> "9.5%",
 * 0.1 -> "10.0%", 0.25 -> "25.0%". Use this for every commission-rate display.
 */
export function fmtRatePct(rate: number | null | undefined): string {
  return `${((rate ?? 0) * 100).toFixed(1)}%`;
}



/**
 * Format an ISO/parseable date string as dd/mm/yyyy in the Europe/London
 * timezone (handles the GMT/BST shift consistently, regardless of the
 * viewer's own device timezone). Returns '' for a null/invalid input.
 */
export function formatLondonDate(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const d = new Date(input);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(d);
  const day = parts.find((p) => p.type === 'day')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const year = parts.find((p) => p.type === 'year')!.value;
  return `${day}/${month}/${year}`;
}

/**
 * Format an ISO/parseable date string as dd/mm/yyyy - HH:mm in the
 * Europe/London timezone. Returns '' for a null/invalid input.
 */
export function formatLondonDateTime(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const d = new Date(input);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const day = parts.find((p) => p.type === 'day')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const year = parts.find((p) => p.type === 'year')!.value;
  const hour = parts.find((p) => p.type === 'hour')!.value;
  const minute = parts.find((p) => p.type === 'minute')!.value;
  return `${day}/${month}/${year} - ${hour}:${minute}`;
}