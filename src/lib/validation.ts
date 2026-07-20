/* =====================================================================
   Shared form validation. Pure functions, so the same rules apply in mock
   and Supabase mode, and they mirror the database constraints and the
   create_referral RPC checks exactly.
   ===================================================================== */

export const TITLE_OPTIONS = ['Mr', 'Mrs', 'Miss', 'Ms', 'Mx', 'Dr'] as const;

// UK postcode (full, with inward code). Case-insensitive; optional space.
export const UK_POSTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Strict yyyy-mm-dd parse (native date-input value). */
export function parseISODate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s || '').trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Build a Date only if the parts form a real calendar date (rejects 31/02 etc.). */
function realDate(y: number, mIdx: number, day: number): Date | null {
  if (y < 1000 || mIdx < 0 || mIdx > 11 || day < 1 || day > 31) return null;
  const d = new Date(y, mIdx, day);
  return (d.getFullYear() === y && d.getMonth() === mIdx && d.getDate() === day) ? d : null;
}
/**
 * #103 Tolerant date parser for pasted values from external systems (Rightmove's
 * ops floor copy-pastes tenancy dates). Accepts, in order of preference, ISO
 * (2026-09-01), UK numeric (01/09/2026 or 1/9/2026, also with '-' or '.'), and
 * month-name forms (1 Sep 2026, 1 September 2026, Sep 1 2026). UK convention:
 * numeric d/m/y is day-first. Returns a Date at local midnight, or null.
 */
export function parseFlexibleDate(input: string): Date | null {
  const s = (input || '').trim();
  if (!s) return null;
  // ISO yyyy-mm-dd
  const iso = parseISODate(s);
  if (iso) return iso;
  // Numeric d/m/y (or d-m-y, d.m.y), day-first
  const num = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (num) {
    let y = +num[3];
    if (y < 100) y += y < 70 ? 2000 : 1900; // 2-digit year window
    return realDate(y, +num[2] - 1, +num[1]);
  }
  // Month-name forms: "1 Sep 2026" / "1 September 2026" / "Sep 1 2026" / "September 1, 2026"
  const cleaned = s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const dmy = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(cleaned);
  const mdy = /^([A-Za-z]{3,})\s+(\d{1,2})\s+(\d{4})$/.exec(cleaned);
  if (dmy) {
    const mIdx = MONTHS.indexOf(dmy[2].slice(0, 3).toLowerCase());
    return mIdx >= 0 ? realDate(+dmy[3], mIdx, +dmy[1]) : null;
  }
  if (mdy) {
    const mIdx = MONTHS.indexOf(mdy[1].slice(0, 3).toLowerCase());
    return mIdx >= 0 ? realDate(+mdy[3], mIdx, +mdy[2]) : null;
  }
  return null;
}
/** yyyy-mm-dd (local) from a Date, for native date-input values. */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addYears(d: Date, n: number): Date {
  return new Date(d.getFullYear() + n, d.getMonth(), d.getDate());
}

export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test((s || '').trim());
}
export function isValidPostcode(s: string): boolean {
  return UK_POSTCODE_RE.test((s || '').trim());
}

function startOfToday(): Date {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

//our code updated

export function isTenancyStartInAllowedRange(value: Date, referenceDate: Date = startOfToday()): boolean {
  const minStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() - 7);
  const maxStart = new Date(referenceDate.getFullYear() + 2, referenceDate.getMonth(), referenceDate.getDate());
  return value >= minStart && value <= maxStart;
}

export interface ReferralValues {
  title: string;
  first: string;
  last: string;
  dob: string;
  email: string;
  phone: string;
  addr1: string;
  addr2: string;
  city: string;
  county: string;
  postcode: string;
  rent: string;
  tenancyStart: string;
  agency: string;
  branch: string;
}

export type ReferralErrors = Partial<Record<keyof ReferralValues, string>>;

/** Validate the new-application form against the required-field spec. */
export function validateReferral(v: ReferralValues): ReferralErrors {
  const e: ReferralErrors = {};

  if (!(TITLE_OPTIONS as readonly string[]).includes(v.title)) e.title = 'Select a title';
  if (!v.first.trim()) e.first = 'Enter a first name';
  if (!v.last.trim()) e.last = 'Enter a last name';

  const dob = parseISODate(v.dob);
  const start = parseISODate(v.tenancyStart);
  if (!dob) e.dob = 'Enter a valid date of birth';
  else if (dob >= startOfToday()) e.dob = 'Date of birth must be in the past';

  if (!isValidEmail(v.email)) e.email = 'Enter a valid email address';
  if (!v.phone.trim() || !/[0-9]/.test(v.phone)) e.phone = 'Enter a phone number';

  if (!v.addr1.trim()) e.addr1 = 'Enter address line 1';
  if (!v.city.trim()) e.city = 'Enter a city or town';
  if (!isValidPostcode(v.postcode)) e.postcode = 'Enter a valid UK postcode';

  const rent = Number(v.rent);
  if (!v.rent.trim() || !Number.isFinite(rent) || rent <= 0) e.rent = 'Enter a monthly rent greater than 0';

  // Tenancy start: a real date within a sensible range (7 days ago to 2 years ahead).
  if (!start) {
    e.tenancyStart = 'Enter a valid tenancy start date';
  } 
  //Our code 
  else {
    const t = startOfToday();
    if (!isTenancyStartInAllowedRange(start, t)) {
      if (start < new Date(t.getFullYear(), t.getMonth(), t.getDate() - 7)) e.tenancyStart = 'Tenancy start cannot be more than 7 days in the past';
      else e.tenancyStart = 'Tenancy start cannot be more than 2 years ahead';
    }
  }
  
  //client code
  // else {
  //   const t = startOfToday();
  //   const minStart = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 7);
  //   const maxStart = new Date(t.getFullYear() + 2, t.getMonth(), t.getDate());
  //   if (start < minStart) e.tenancyStart = 'Tenancy start cannot be more than 7 days in the past';
  //   else if (start > maxStart) e.tenancyStart = 'Tenancy start cannot be more than 2 years ahead';
  // }

  // Combined age rule (re-checked whenever either date changes): 18 by the tenancy start,
  // and not implausibly old. DOB + 18 years must be on or before the tenancy start.
  if (dob && start && !e.dob) {
    if (addYears(dob, 18) > start) e.dob = 'Tenant must be 18 by the tenancy start date.';
    else if (addYears(dob, 100) < start) e.dob = 'Check the date of birth: the tenant would be over 100 at the tenancy start.';
  }

  if (!v.agency.trim()) e.agency = 'Select an agent';
  if (!v.branch.trim()) e.branch = 'Select a branch';

  return e;
}
