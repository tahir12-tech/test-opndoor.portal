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
  } else {
    const t = startOfToday();
    const minStart = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 7);
    const maxStart = new Date(t.getFullYear() + 2, t.getMonth(), t.getDate());
    if (start < minStart) e.tenancyStart = 'Tenancy start cannot be more than 7 days in the past';
    else if (start > maxStart) e.tenancyStart = 'Tenancy start cannot be more than 2 years ahead';
  }

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
