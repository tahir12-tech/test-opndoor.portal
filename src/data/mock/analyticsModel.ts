/* =====================================================================
   Parametric analytics model (ported from dashboard.html).
   The prototype does NOT sum real records — it generates every dashboard
   figure from a base volume per period, conversion rates and an average
   rent, scaled by partner weight. Exports synthesise rows to match those
   counts.

   This is the MOCK/TEST-mode analytics only. In live mode analyticsService /
   exportsService compute every figure from the hydrated live application set
   (src/data/liveAnalytics.ts); this model is the fallback the render smoke test
   and env-less dev run against, so it stays.
   ===================================================================== */

export const AVG_RENT = 2180; // average monthly rent (constant)
export const ANNUAL = AVG_RENT * 12; // annual rent per issued deed (total guaranteed value)
export const REF_FRACTION = 38 / 342; // a referrer's own slice vs the whole portfolio

/** A chart row: [label, referralCount, feesCollected, subLabel?]. */
export type ShapeRow = [string, number, number, string?];

export interface PeriodDef {
  id: string;
  label: string;
  fSent: number;
  sp: number;
  pd: number;
}

/** Time periods in display order. fSent = whole-portfolio referrals sent in window. */
export const PERIODS: PeriodDef[] = [
  { id: 'last7', label: 'Last 7 days', fSent: 31, sp: 0.74, pd: 0.88 },
  { id: 'last30', label: 'Last 30 days', fSent: 118, sp: 0.77, pd: 0.89 },
  { id: 'last90', label: 'Last 90 days', fSent: 342, sp: 0.783, pd: 0.9 },
  { id: 'last12m', label: 'Last 12 months', fSent: 1284, sp: 0.8, pd: 0.91 },
  { id: 'thismonth', label: 'This calendar month', fSent: 86, sp: 0.72, pd: 0.86 },
  { id: 'lastmonth', label: 'Last calendar month', fSent: 127, sp: 0.79, pd: 0.9 },
  { id: 'alltime', label: 'All time', fSent: 2960, sp: 0.8, pd: 0.91 },
];
export const DEFAULT_PERIOD = 'thismonth';

/** 90-day baseline distributions for the whole portfolio. */
export const SHAPE_FULL: { branches: ShapeRow[]; agencies: ShapeRow[]; referrers: ShapeRow[] } = {
  branches: [
    ['South Kensington', 78, 169000, 'Foxglove Residential'],
    ['Marylebone', 72, 147000, 'Marylebone & Co'],
    ['Shoreditch', 63, 101000, 'Northbank Lettings'],
    ['Chelsea', 61, 153000, 'Foxglove Residential'],
    ['Clapham', 58, 82000, 'Hartwell Estates'],
    ['Fitzrovia', 54, 110000, 'Marylebone & Co'],
  ],
  agencies: [
    ['Foxglove Residential', 214, 246240],
    ['Marylebone & Co', 152, 168000],
    ['Northbank Lettings', 108, 98000],
    ['Hartwell Estates', 96, 72000],
  ],
  referrers: [
    ['Priya Nair', 38, 88000],
    ['James Okafor', 33, 82000],
    ['Sophie Bennett', 29, 63000],
    ['Daniel Wright', 24, 57000],
    ['Aisha Khan', 21, 45000],
    ['Marcus Lin', 17, 34000],
  ],
};

/** Referrer's own slice. */
export const SHAPE_REF: { branches: ShapeRow[]; agencies: ShapeRow[]; referrers: ShapeRow[] } = {
  branches: [
    ['South Kensington', 16, 37000, 'Foxglove Residential'],
    ['Chelsea', 13, 34000, 'Foxglove Residential'],
    ['Fulham', 9, 18000, 'Foxglove Residential'],
  ],
  agencies: [['Foxglove Residential', 38, 88000]],
  referrers: [
    ['April', 14, 32000],
    ['March', 13, 30000],
    ['February', 11, 27000],
  ],
};

export const BASE_SENT_FULL = 342;
export const BASE_PAID_FULL = 268;
export const BASE_SENT_REF = 38;
export const BASE_PAID_REF = 30;

/** Trailing 12 months [label, referralCount]. */
export const TREND_MONTHS: [string, number][] = [
  ['Jul 2025', 85], ['Aug 2025', 92], ['Sep 2025', 98], ['Oct 2025', 104],
  ['Nov 2025', 96], ['Dec 2025', 78], ['Jan 2026', 102], ['Feb 2026', 110],
  ['Mar 2026', 118], ['Apr 2026', 126], ['May 2026', 134], ['Jun 2026', 141],
];

/** Scale a set of shape rows by a count factor (kc) and a fees factor (kf). */
export function scaleRows(rows: ShapeRow[], kc: number, kf: number): ShapeRow[] {
  return rows.map((r) => {
    const row: ShapeRow = [r[0], Math.max(1, Math.round(r[1] * kc)), Math.max(0, Math.round(r[2] * kf))];
    if (r[3] !== undefined) row.push(r[3]);
    return row;
  });
}

/* ---------- Export-only synthetic data (application-level + bordereau) ---------- */

/** [branch, agency] pairs used when synthesising application rows. */
export const APP_BRANCHES: [string, string][] = [
  ['South Kensington', 'Foxglove Residential'], ['Chelsea', 'Foxglove Residential'], ['Fulham', 'Foxglove Residential'],
  ['Marylebone', 'Marylebone & Co'], ['Fitzrovia', 'Marylebone & Co'],
  ['Clapham', 'Hartwell Estates'], ['Balham', 'Hartwell Estates'],
  ['Shoreditch', 'Northbank Lettings'], ['Islington', 'Northbank Lettings'],
];
export const APP_REFERRERS = ['Priya Nair', 'James Okafor', 'Sophie Bennett', 'Daniel Wright', 'Aisha Khan', 'Marcus Lin', 'Oliver Grant'];
export const APP_RENTS = [1650, 1780, 1850, 1950, 2050, 2180, 2300, 2450, 2650, 2800];

/** Bordereau (underwriter declaration) synthetic tenant pools. */
export const BX_TITLES = ['Mr', 'Ms', 'Mrs', 'Mx', 'Dr'];
export const BX_FIRST = ['Amelia', 'Chen', 'Mohammed', 'Sofia', 'Tariq', 'Grace', 'Lukas', 'Yuki', 'Isabella', 'Daniel', 'Priya', 'Omar', 'Hannah', 'Carlos', 'Aisha', 'Noah', 'Leila', 'Marcus', 'Freya', 'Idris', 'Mei', 'Jonas', 'Nadia', 'Theo'];
export const BX_LAST = ['Hartley', 'Wei', 'Al-Rashid', 'Almeida', 'Hassan', 'Okonkwo', 'Muller', 'Tanaka', 'Rossi', 'Mensah', 'Raman', 'Farouk', 'Schmidt', 'Vega', 'Khan', 'Bennett', 'Okafor', 'Nair', 'Wright', 'Lin', 'Adeyemi', 'Clarke', 'Voss', 'Grant'];
export const BX_STREETS: [string, string][] = [
  ['18 Onslow Gardens', 'SW7 3LA'], ['22 Cale Street', 'SW3 3QU'], ['5 Bina Gardens', 'SW5 0LA'], ['41 Marylebone High Street', 'W1U 5HR'],
  ['12 Charlotte Street', 'W1T 2LP'], ['88 Northcote Road', 'SW11 6QW'], ['30 Rivington Street', 'EC2A 3DZ'], ['14 Upper Street', 'N1 0PQ'],
  ['60 Fulham Road', 'SW3 6HH'], ['5 Bedford Hill', 'SW12 9RW'], ['9 Goodge Street', 'W1T 2QJ'], ['77 Old Brompton Road', 'SW7 3LQ'],
  ['23 Hoxton Square', 'N1 6NN'], ["102 St John's Hill", 'SW11 1SA'], ['7 Cleaver Square', 'SE11 4EA'], ['44 Bedford Hill', 'SW12 9HD'],
];
export const BX_FLATS = ['', 'Flat 2', 'Flat 4', 'Studio 7', 'Apartment 3', 'Flat B', ''];

/** The single configurable underwriter insurance rate (percent), set in the bordereau modal. */
export const DEFAULT_INSURANCE_RATE = 13.5;

/* ---------- Per-entity conversion [sentToPaid, paidToDeed] ---------- */
// Keyed by name so it is independent of the positional row format. Sent-to-Deed = product.
// Shared by the dashboard breakdown charts and the League tables.
export const CONV_BRANCH: Record<string, [number, number]> = {
  'South Kensington': [0.82, 0.93], Marylebone: [0.79, 0.9], Shoreditch: [0.74, 0.88], Chelsea: [0.85, 0.92],
  Clapham: [0.71, 0.86], Fitzrovia: [0.8, 0.9], Fulham: [0.77, 0.89], Islington: [0.73, 0.87], Balham: [0.69, 0.85],
};
export const CONV_AGENCY: Record<string, [number, number]> = {
  'Foxglove Residential': [0.83, 0.92], 'Marylebone & Co': [0.79, 0.9], 'Northbank Lettings': [0.74, 0.87], 'Hartwell Estates': [0.7, 0.85],
};
/** Conversion pair for an agency or branch, falling back to a portfolio default. */
export function convFor(key: 'agency' | 'branch', name: string): [number, number] {
  const map = key === 'agency' ? CONV_AGENCY : CONV_BRANCH;
  return map[name] || [0.78, 0.9];
}

/** Referrer pool for the League tables (larger than the dashboard's top-six sample). */
export const LEAGUE_REFERRER_NAMES = [
  'Priya Nair', 'James Okafor', 'Sophie Bennett', 'Daniel Wright', 'Aisha Khan', 'Marcus Lin', 'Oliver Grant', 'Naomi Clarke',
  'Tom Fielding', 'Ruth Amankwah', 'Leo Barros', 'Hannah Vaughan', 'Sam Okafor', 'Divya Menon', 'Chris Elliot', 'Beatrice Lund',
  'Yusuf Adan', 'Grace Bell', 'Nadia Rahman', 'Owen Pryce', 'Elena Costa', 'Josh Kaplan',
];
