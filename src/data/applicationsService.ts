/* =====================================================================
   Applications service.
   Enforces partner isolation and the referrer "own referrals only" rule,
   builds the display-ready detail record, and exposes the referral
   lifecycle actions.

   Live mode reads the RLS-scoped working copies hydrated from Supabase and
   filters/sorts client-side; the role + scope isolation shown here is ALSO
   enforced server-side by RLS. The lifecycle actions call Edge Functions:
   createReferral -> create-referral (Stripe Checkout + branded email),
   amendTenancyStartDb -> amend-tenancy-start (deed-state-aware reissue),
   sendDeedToAgent -> send_deed_to_agent RPC. Mock/test mode uses the seed.
   ===================================================================== */
import type { ApplicationDetail, ApplicationSummary, DeedState, PartnerScope, Role, Status, WithdrawReason } from './types';
import { ALL_PARTNERS } from './types';
import { AGENT_ADDR, APPLICATION_RECORDS as RECORDS_SEED, APPLICATIONS_LIST as LIST_SEED, type AppRecord } from './mock/applications';
import { partnerName } from './partnersService';
import { contactForApplication } from './orgService';
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';

// Working copies. Seeded from the mock; replaced from Supabase after login.
// Mock summaries carry no referrer name (only `owner`); derive it from the detail
// records by ref so the Applications referrer filter has data in mock/demo mode.
// Live mode replaces LIST wholesale, with referrer + sentAtTs set in hydrate.
const REFERRER_BY_REF = new Map(RECORDS_SEED.map((r) => [r.ref, r.referrer]));
let LIST: ApplicationSummary[] = LIST_SEED.map((s) => ({ ...s, referrer: s.referrer ?? REFERRER_BY_REF.get(s.ref) ?? null }));
let RECORDS: AppRecord[] = RECORDS_SEED;

/** Replace the applications working copies from the back end (Supabase mode). */
export function hydrateApplications(list: ApplicationSummary[], records: AppRecord[]): void {
  LIST = list;
  RECORDS = records;
}

/** The full scoped summary set (used by the activity feed). */
export function allSummaries(): ApplicationSummary[] {
  return LIST;
}

/** Full per-application record (real mode) for analytics and exports. */
export interface FullApp {
  ref: string;
  partner: string;
  agency: string;
  branch: string;
  referrer: string;
  /** The referring user's actual role (superadmin/management/referrer), so the
      league can label who generated the referral truthfully. */
  referrerRole?: Role | null;
  owner: number;
  status: Status;
  rent: number;
  /** Commission rates SNAPSHOTTED at creation (fractions of one month's rent).
      Every commission/settlement/league/export figure reads these, never the
      partner's live rate, so editing a partner's rate never moves history. */
  partnerRate: number;
  agentRate: number;
  sentAt: Date | null;
  paidAt: Date | null;
  deedAt: Date | null;
  tenancyStart: Date | null;
  expiry: Date | null;
  refunded: boolean;
  refundedAt: Date | null;
  refundedAmount: number | null;
  refundAfterStart: boolean;
  /** Deed sub-state while Paid, or null before a deed exists. */
  deedState: DeedState | null;
  deedSentAt: Date | null;
  /** When the tenant first opened the deed to sign (null = not yet viewed). */
  deedViewedAt: Date | null;
  /** #2 True when withdrawn at Sent (terminal, pre-payment). */
  withdrawn: boolean;
  withdrawnReason: WithdrawReason | null;
  withdrawnNote: string | null;
  /** #13 True when auto-expired (unpaid 14 days after Sent); terminal, pre-payment. */
  expired: boolean;
}

let FULL: FullApp[] = [];
let HYDRATED = false;

/** Replace the full application set from the back end (Supabase mode). */
export function hydrateFull(rows: FullApp[]): void {
  FULL = rows.slice();
  HYDRATED = true;
}

/** The full application set (empty in mock mode). */
export function allFull(): FullApp[] {
  return FULL;
}

/**
 * True once the live application set has been hydrated from Supabase — even if
 * the viewer's scope is genuinely empty. Live analytics keys on this (not on
 * "any rows present") so a real but empty scope shows honest zeros rather than
 * silently falling back to the synthetic mock model.
 */
export function isHydrated(): boolean {
  return HYDRATED;
}

const STATUS_LABEL: Record<Status, string> = { sent: 'Sent', paid: 'Paid', deed: 'Deed Issued', withdrawn: 'Withdrawn', expired: 'Expired' };

export interface AppScopeOpts {
  role: Role;
  scope: PartnerScope;
  /** opndoor admin's optional in-page partner sub-filter. */
  partner?: string;
  /** #owner Period range [start, end]; when set, status counts recount to apps
      whose SENT date falls in it (matching the dashboard period options). */
  periodRange?: [Date, Date];
}

export interface AppFilterOpts extends AppScopeOpts {
  /** 'refunded' and 'awaiting' (deed out for signature) are cross-cuts of Paid;
      'delivery-failed' is a cross-cut of Deed (issued but not delivered to an
      agent contact, #84). */
  status?: Status | 'all' | 'refunded' | 'awaiting' | 'delivery-failed' | 'withdrawn' | 'expired';
  agency?: string;
  branch?: string;
  /** #owner Referrer display-name filter (management + opndoor admin only). */
  referrer?: string;
  q?: string;
  sort?: string;
}

/** Role + partner isolation only (drives counts and the "total" figure). */
function scopedSet(opts: AppScopeOpts): ApplicationSummary[] {
  let set = LIST.slice();
  if (opts.scope !== ALL_PARTNERS) set = set.filter((r) => r.partner === opts.scope);
  if (opts.role === 'referrer') set = set.filter((r) => r.owner);
  return set;
}

/** #owner Sent-date epoch ms for period filtering: the true sent time when
    hydrated, else the summary's anchor-event day (mock rows have no separate
    sent date, and are dated close to their sent date). */
function sentTsOf(r: ApplicationSummary): number {
  return r.sentAtTs != null ? r.sentAtTs : new Date(r.date).getTime();
}
function inPeriod(r: ApplicationSummary, range?: [Date, Date]): boolean {
  if (!range) return true;
  const ts = sentTsOf(r);
  return ts >= range[0].getTime() && ts <= range[1].getTime();
}

export function countByStatus(opts: AppFilterOpts): { all: number; sent: number; paid: number; deed: number; refunded: number; awaiting: number; deliveryFailed: number; withdrawn: number; expired: number } {
  // #owner Chips recount within the selected period (sent-date bucketed), and
  // must follow the same partner/agency/branch/referrer filters as the rows.
  let set = scopedSet(opts);
  if (opts.partner) set = set.filter((r) => r.partner === opts.partner);
  set = set.filter((r) => {
    if (opts.branch && r.branch !== opts.branch) return false;
    if (opts.agency && r.agency !== opts.agency) return false;
    if (opts.referrer && r.referrer !== opts.referrer) return false;
    return inPeriod(r, opts.periodRange);
  });
  // 'refunded' and 'awaiting' overlap 'paid' (both keep status Paid by design), so
  // they are counted in addition to paid, not instead of it. all = sent+paid+deed.
  // 'deliveryFailed' is a cross-cut of Deed (issued but no reachable agent contact).
  // #2/#13 'withdrawn' and 'expired' are terminal and OUT of the funnel: not part of
  // all/sent/paid/deed, only their own separate counts (surfaced via their chips).
  const counts = { all: 0, sent: 0, paid: 0, deed: 0, refunded: 0, awaiting: 0, deliveryFailed: 0, withdrawn: 0, expired: 0 };
  set.forEach((r) => {
    if (r.status === 'withdrawn') { counts.withdrawn++; return; }
    if (r.status === 'expired') { counts.expired++; return; }
    counts.all++;
    counts[r.status]++;
    if (r.refunded) counts.refunded++;
    if (r.awaitingSignature) counts.awaiting++;
    // #93 Delivery-failure is an ops surface: never counted for referrers.
    if (opts.role !== 'referrer' && r.status === 'deed' && !contactForApplication(r.agency, r.branch).contact) counts.deliveryFailed++;
  });
  return counts;
}

/** The visible rows for the given filters (scoped + status/agency/branch/search/sort). */
export function getApplications(opts: AppFilterOpts): ApplicationSummary[] {
  let rows = scopedSet(opts);
  if (opts.partner) rows = rows.filter((r) => r.partner === opts.partner);
  rows = rows.filter((r) => {
    // #2/#13 Withdrawn and Expired are terminal and out of the default/every-other
    // view; each appears only when its own chip is selected.
    if ((r.status === 'withdrawn' || r.status === 'expired') && opts.status !== r.status) return false;
    if (opts.status === 'refunded') { if (!r.refunded) return false; }
    else if (opts.status === 'awaiting') { if (!r.awaitingSignature) return false; }
    else if (opts.status === 'delivery-failed') { if (opts.role === 'referrer' || !(r.status === 'deed' && !contactForApplication(r.agency, r.branch).contact)) return false; }
    else if (opts.status && opts.status !== 'all' && r.status !== opts.status) return false;
    if (opts.branch && r.branch !== opts.branch) return false;
    if (opts.agency && r.agency !== opts.agency) return false;
    // #owner Referrer filter (management + opndoor admin) and period (sent-date).
    if (opts.referrer && r.referrer !== opts.referrer) return false;
    if (!inPeriod(r, opts.periodRange)) return false;
    if (opts.q) {
      const hay = `${r.tenant} ${r.prop} ${r.ref} ${r.ben} ${r.branch}`.toLowerCase();
      if (!hay.includes(opts.q.toLowerCase())) return false;
    }
    return true;
  });
  const sort = opts.sort || 'Newest first';
  // Sort by the anchor event time (deed/paid/sent) to the second when available,
  // falling back to the day string; ties break by reference so the order is
  // stable and deterministic (never dependent on fetch order).
  const when = (r: ApplicationSummary): number => (r.eventTs != null ? r.eventTs : new Date(r.date).getTime());
  rows = rows.slice().sort((a, b) => {
    if (sort === 'Rent: high to low') return b.rent - a.rent || a.ref.localeCompare(b.ref);
    const diff = when(a) - when(b);
    const chrono = sort === 'Oldest first' ? diff : -diff;
    return chrono || a.ref.localeCompare(b.ref);
  });
  return rows;
}

export interface DuplicateMatch { ref: string; statusLabel: string; }

/** #5 An ACTIVE (non-terminal) application matching the tenant email + property
    postcode, for the soft duplicate warning on New Application. Scope-isolated, so
    a referrer is only warned about their own referrals. Returns null (no false
    warnings) in mock mode, where seed records carry no tenant email. */
export function findActiveReferralByTenantProperty(opts: AppScopeOpts, email: string, postcode: string): DuplicateMatch | null {
  const em = email.trim().toLowerCase();
  const pc = postcode.replace(/\s+/g, '').toLowerCase();
  if (!em || !pc) return null;
  for (const s of scopedSet(opts)) {
    if (s.refunded) continue; // refunded is a terminal cross-cut
    if (s.status === 'withdrawn' || s.status === 'expired') continue; // #2/#13 terminal: not an active duplicate
    const rec = RECORDS.find((r) => r.ref === s.ref);
    const rEm = (rec?.email ?? '').trim().toLowerCase();
    const rPc = (rec?.postcode ?? '').replace(/\s+/g, '').toLowerCase();
    if (rEm && rEm === em && rPc === pc) return { ref: s.ref, statusLabel: STATUS_LABEL[s.status] };
  }
  return null;
}

/** Distinct agency names within a scope (for the applications filter dropdown). */
export function agencyNamesForScope(opts: AppScopeOpts): string[] {
  const rows = scopedSet(opts).filter((r) => (opts.partner ? r.partner === opts.partner : true));
  const names: string[] = [];
  rows.forEach((r) => {
    if (!names.includes(r.agency)) names.push(r.agency);
  });
  return names.sort();
}

/** #owner Distinct referrer names within a scope (for the applications referrer
    filter). Management + opndoor admin surface it; referrers see only their own. */
export function referrerNamesForScope(opts: AppScopeOpts): string[] {
  const rows = scopedSet(opts).filter((r) => (opts.partner ? r.partner === opts.partner : true));
  const names: string[] = [];
  rows.forEach((r) => {
    const n = r.referrer;
    if (n && !names.includes(n)) names.push(n);
  });
  return names.sort();
}

/** Distinct branch names within a scope, optionally limited to one agency. */
export function branchNamesForScope(opts: AppScopeOpts, agency?: string): string[] {
  const rows = scopedSet(opts).filter((r) => (opts.partner ? r.partner === opts.partner : true)).filter((r) => !agency || r.agency === agency);
  const names: string[] = [];
  rows.forEach((r) => {
    if (!names.includes(r.branch)) names.push(r.branch);
  });
  return names.sort();
}

/** Find the parent agency of a branch (used when arriving filtered by ?branch=). */
export function agencyOfBranch(branch: string): string | '' {
  const rec = LIST.find((r) => r.branch === branch);
  return rec ? rec.agency : '';
}

/* ---------- Detail builder (deterministic, ported from portal-apps.js) ---------- */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = 86400000;

function parseISO(s: string): Date {
  const p = s.split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}
function fmtShort(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtLong(d: Date): string {
  return `${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY);
}
/** Local-time HH:MM, matching the timeline's dd Mon yyyy · HH:MM format. */
function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** Whole years from dob to the reference day (birthday-aware). */
function ageOn(dob: Date, today: Date): number {
  let a = today.getFullYear() - dob.getFullYear();
  if (today.getMonth() < dob.getMonth() || (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate())) a -= 1;
  return a;
}

/**
 * The single source of truth for the guarantee expiry date: the tenancy start
 * date plus 12 months, minus one day. It is always computed from the tenancy
 * start date, never from the deed issued or paid date.
 * Example: tenancy start 15/06/2026 gives expiry 14/06/2027.
 * Every screen and export that shows an expiry routes through this function.
 */
export function guaranteeExpiry(tenancyStart: Date): Date {
  // Using a day component of (date - 1) rolls calendar boundaries correctly
  // and avoids millisecond/DST drift.
  return new Date(tenancyStart.getFullYear() + 1, tenancyStart.getMonth(), tenancyStart.getDate() - 1);
}

function deaccent(s: string): string {
  // Strip combining diacritical marks (U+0300–U+036F) after NFD decomposition.
  return s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
}
function initials(n: string): string {
  return n.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

export function findRecord(ref: string | null): AppRecord | null {
  return RECORDS.find((r) => r.ref === ref) ?? null;
}

/** A safe, blank detail flagged not-found, so the detail page can render an
    honest "not accessible" state without ever substituting another record. */
function notFoundDetail(ref: string): ApplicationDetail {
  const now = new Date();
  return {
    ref, status: 'sent', statusLabel: '', withdrawnReason: null, name: '', initials: '', title: '', role: '', fullName: '',
    dob: '', email: '', phone: '', addr1: '', addr2: '', city: '', county: '', postcode: '',
    agency: '', branch: '', partnerName: '', agentAddr: '', rent: '', rentNum: 0, referrer: '', referrerRole: null,
    tenancyStart: '', tenancyStartDate: now, sentAt: now, paidAt: null, deedAt: null,
    sentStr: '', paidStr: null, deedStr: null, issue: null, expiry: null, annual: '',
    paymentDate: null, owner: 0, notFound: true,
  };
}

export function getApplicationDetail(ref: string | null): ApplicationDetail {
  // No silent substitution: a reference that does not exist or is not accessible
  // to the viewer (RLS returned nothing in live mode) yields an honest not-found
  // detail rather than another of the viewer's own records.
  const r = findRecord(ref);
  if (!r) return notFoundDetail(ref ?? '');
  const idx = RECORDS.indexOf(r);

  // A Supabase-hydrated record carries the real Sent timestamp; when present we
  // show exactly what was entered and when each event happened. Mock/seed records
  // (test mode) omit these, so the deterministic stand-ins are used instead.
  const real = r.sentAtTs != null;

  // ---- Timeline (real timestamps in live mode; synthesised offsets otherwise) ----
  let sentAt: Date;
  let paidAt: Date | undefined;
  let deedAt: Date | undefined;
  if (real) {
    sentAt = new Date(r.sentAtTs as string);
    paidAt = r.paidAtTs ? new Date(r.paidAtTs) : undefined;
    deedAt = r.deedAtTs ? new Date(r.deedAtTs) : undefined;
  } else {
    const event = parseISO(r.date);
    if (r.status === 'deed') {
      deedAt = event;
      paidAt = addDays(event, -2);
      sentAt = addDays(event, -6);
    } else if (r.status === 'paid') {
      paidAt = event;
      sentAt = addDays(event, -4);
    } else {
      sentAt = event;
    }
  }

  const tenancyStart = real && r.tenancyStartTs ? new Date(r.tenancyStartTs) : addDays(sentAt, 16);

  // ---- Date of birth + age ----
  const today = SUPABASE_ENABLED ? new Date() : new Date(2026, 5, 26);
  let dob: Date;
  if (real && r.dob) {
    dob = parseISO(r.dob);
  } else {
    const dobYear = 1999 - (idx % 9);
    dob = new Date(dobYear, (idx * 5) % 12, ((idx * 7) % 27) + 1);
  }
  const age = ageOn(dob, today);

  // ---- Contact + property (real values in live mode; synthesised otherwise) ----
  const emailUser = deaccent(r.name).toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.');
  const phoneTail = r.ref.replace(/\D/g, '').slice(-3);
  const email = real ? (r.email ?? '') : `${emailUser}@gmail.com`;
  const phone = real ? (r.phone ?? '') : `+44 7700 900${phoneTail}`;
  const addr2 = real ? (r.addr2 ?? '') : '';
  const city = real ? (r.city ?? '') : 'London';
  const county = real ? (r.county ?? '') : 'Greater London';
  const annual = r.rent * 12;

  return {
    ref: r.ref,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status],
    withdrawnReason: r.withdrawnReason ?? null,
    name: r.name,
    initials: initials(r.name),
    title: r.title,
    role: r.role,
    fullName: `${r.title} ${r.name}`.trim(),
    dob: `${fmtLong(dob)} (${age})`,
    email,
    phone,
    addr1: r.addr1,
    addr2,
    city,
    county,
    postcode: r.postcode,
    agency: r.agency,
    branch: r.branch,
    // Partner is only on the summary LIST (both mock and live), not AppRecord.
    partnerName: partnerName(LIST.find((x) => x.ref === r.ref)?.partner ?? ''),
    agentAddr: AGENT_ADDR[r.branch] || `${r.branch}, London`,
    rent: `£${r.rent.toLocaleString('en-GB')}`,
    rentNum: r.rent,
    referrer: r.referrer,
    // referrerRole is on the summary LIST (like partner), not AppRecord (#112).
    referrerRole: LIST.find((x) => x.ref === r.ref)?.referrerRole ?? null,
    tenancyStart: fmtLong(tenancyStart),
    tenancyStartDate: tenancyStart,
    sentAt,
    paidAt: paidAt || null,
    deedAt: deedAt || null,
    sentStr: `${fmtShort(sentAt)} · ${real ? fmtTime(sentAt) : '10:24'}`,
    paidStr: paidAt ? `${fmtShort(paidAt)} · ${real ? fmtTime(paidAt) : '16:09'}` : null,
    deedStr: deedAt ? `${fmtShort(deedAt)} · ${real ? fmtTime(deedAt) : '09:41'}` : null,
    issue: deedAt ? fmtShort(deedAt) : null,
    // Expiry is always tenancy start + 12 months - 1 day, never anchored on the deed date.
    expiry: deedAt ? fmtShort(guaranteeExpiry(tenancyStart)) : null,
    annual: `£${annual.toLocaleString('en-GB')}`,
    paymentDate: paidAt || null,
    owner: r.owner,
  };
}

/* ---------- Lifecycle actions ---------- */

export interface CreateReferralInput {
  title: string;
  firstName: string;
  lastName: string;
  dob: string;
  email: string;
  phone: string;
  addr1: string;
  addr2: string;
  city: string;
  county: string;
  postcode: string;
  rent: number;
  tenancyStart: string;
  agency: string;
  branch: string;
  /** On-the-fly org creation: whether the agency/branch were created inline, and
      the contact to capture (agency contact email required when agencyNew). */
  agencyNew?: boolean;
  branchNew?: boolean;
  agencyContactEmail?: string;
  agencyContactName?: string;
  agencyContactPhone?: string;
  branchContactEmail?: string;
  /** The partner an on-the-fly agency/branch belongs to. Ignored server-side for
      partner users (their own partner is authoritative); required for an opndoor
      admin fly-creating a brand-new agency. Null when scope is "all partners". */
  partner?: string;
}

/**
 * Create a referral (status = Sent). In live mode this invokes the create-referral
 * Edge Function, which validates + inserts as the caller (RLS applies), opens a
 * Stripe test Checkout Session for the guarantor fee and emails the branded
 * payment link; the guarantee reference is assigned by the DB. Stripe (paid) then
 * PandaDoc (deed) advance it via webhooks. Mock/test mode returns a synthetic ref.
 */
export interface CreateReferralResult {
  ref: string;
  paymentUrl: string | null;
  emailSent: boolean;
  emailError: string | null;
}

export async function createReferral(input: CreateReferralInput): Promise<CreateReferralResult> {
  if (!SUPABASE_ENABLED) {
    return { ref: `GR-${30000 + Math.floor(LIST.length)}`, paymentUrl: null, emailSent: false, emailError: null };
  }
  // Creating the referral IS the send: the create-referral Edge Function validates
  // and inserts (as the caller, so RLS + field rules apply), opens a Stripe test
  // Checkout Session for the guarantor fee, and emails the tenant the branded
  // payment email (redirected to the review address in test mode).
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const { data, error } = await sb().functions.invoke('create-referral', {
    body: {
      agency: input.agency, branch: input.branch, origin,
      title: input.title, firstName: input.firstName, lastName: input.lastName,
      dob: input.dob || null, email: input.email, phone: input.phone,
      addr1: input.addr1, addr2: input.addr2, city: input.city, county: input.county, postcode: input.postcode,
      rent: input.rent, tenancyStart: input.tenancyStart || null,
      agencyContactEmail: input.agencyContactEmail || null,
      agencyContactName: input.agencyContactName || null,
      agencyContactPhone: input.agencyContactPhone || null,
      branchContactEmail: input.branchContactEmail || null,
      partner: input.partner || null,
    },
  });
  if (error) {
    let msg = error.message as string;
    try {
      const ctx = await (error as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch { /* ignore */ }
    throw new Error(msg || 'Could not create the referral.');
  }
  if (!data?.ok) throw new Error(data?.error || 'Could not create the referral.');
  return { ref: data.ref, paymentUrl: data.paymentUrl ?? null, emailSent: !!data.emailSent, emailError: data.emailError ?? null };
}

/**
 * Persist a tenancy-start amendment via the amend-tenancy-start Edge Function.
 * The function calls the amend_tenancy_start RPC (deed-state-aware permission,
 * AAL2, ownership) then orchestrates the deed: void+regenerate while awaiting
 * signature, or archive+replace once executed. Returns the server's summary.
 * No-op in mock mode. The UI calculation is amendTenancyStart above.
 */
/** #81 Count of submitted-and-unresolved agent tenancy-start corrections in the
    caller's scope (admin: all; management: their partner). 0 in mock mode. */
export async function pendingTenancyCorrections(): Promise<number> {
  if (!SUPABASE_ENABLED) return 0;
  const { data, error } = await sb().rpc('count_pending_tenancy_corrections');
  if (error) return 0;
  return Number(data) || 0;
}

export async function amendTenancyStartDb(ref: string, newStart: Date, confirmReissue = false): Promise<string | undefined> {
  if (!SUPABASE_ENABLED) return undefined;
  const iso = `${newStart.getFullYear()}-${String(newStart.getMonth() + 1).padStart(2, '0')}-${String(newStart.getDate()).padStart(2, '0')}`;
  const { data, error } = await sb().functions.invoke('amend-tenancy-start', { body: { ref, newStart: iso, confirmReissue } });
  if (error) throw new Error('Could not amend the tenancy start date.');
  // #82 A signed deed needs an explicit consequence confirmation before the server
  // proceeds; surface that distinctly so the UI can prompt and retry.
  if (data?.needsConfirm) { const e = new Error(data.error || 'Confirmation required.'); (e as Error & { needsConfirm?: boolean }).needsConfirm = true; throw e; }
  if (!data?.ok) throw new Error(data?.error || 'Could not amend the tenancy start date.');
  return data.message as string | undefined;
}

/**
 * Send the issued deed to the agent via the send-deed-to-agent Edge Function,
 * which enforces canSendDeed / the referrer restriction (send_deed_to_agent RPC)
 * and then delivers the same branded deed email the automatic path sends on
 * execution. This is the manual / recovery-resend path. No-op in mock mode.
 */
export async function sendDeedToAgent(ref: string, recipientEmail?: string, saveContact?: boolean): Promise<{ sentTo?: string }> {
  if (!SUPABASE_ENABLED) return {};
  const { data, error } = await sb().functions.invoke('send-deed-to-agent', {
    body: { ref, recipientEmail: recipientEmail ?? null, saveContact: saveContact ?? false },
  });
  if (error) {
    let msg = error.message as string;
    try {
      const ctx = await (error as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch { /* ignore */ }
    throw new Error(msg || 'Could not send the deed to the agent.');
  }
  if (!data?.ok) throw new Error(data?.error || 'Could not send the deed to the agent.');
  return { sentTo: data.sentTo as string | undefined };
}

/**
 * Who may amend the tenancy start date, by deed state:
 * - Sent, or Paid-but-unexecuted (deed_state not 'executed'): any viewing role
 *   may amend; a Referrer only their own. While a deed is awaiting signature the
 *   outstanding document is voided and regenerated so the corrected date prints.
 * - Executed deed (status 'deed' / deed_state 'executed'): Management and opndoor
 *   admin only, and the signed PDF is archived before a replacement is issued.
 * The back end (amend_tenancy_start RPC + amend-tenancy-start Edge Function)
 * enforces this rule independently.
 */
export function canAmendTenancyStart(role: Role, status: Status, ownedByReferrer: boolean, deedState: string | null = null): boolean {
  // Once the deed is executed (issued), only Management and opndoor admin may
  // amend (the signed deed is archived and replaced). Before that - Sent, or
  // Paid-but-unexecuted - the owning Referrer may amend too.
  if (status === 'deed' || deedState === 'executed') return role === 'superadmin' || role === 'management';
  return role === 'referrer' ? ownedByReferrer : true;
}

/**
 * Who may send the issued deed to the agent. Referrers may send, but only on
 * their own application; Management and opndoor admin may send on any in scope.
 * Referrers are send-only (no one-off recipient, no saving contacts) — that is
 * enforced in the UI. The back end must enforce this rule independently.
 */
export function canSendDeed(role: Role, ownedByReferrer: boolean): boolean {
  if (role === 'referrer') return ownedByReferrer;
  return role === 'superadmin' || role === 'management';
}

/**
 * Who may "Replace and resend deed" (void the outstanding PandaDoc document and
 * issue a fresh one) while a deed is awaiting signature: Management and opndoor
 * admin only, never Referrers. The tenant-nudge "Resend signature request" is
 * available to every authorised viewer (owning Referrer, Management, admin) and
 * so is not gated here. The back end (pandadoc-void-regenerate) re-checks this.
 */
export function canReplaceDeed(role: Role): boolean {
  return role === 'superadmin' || role === 'management';
}

/**
 * #2 Who may withdraw an application: only while it is at Sent (before payment).
 * The owning Referrer may withdraw their own; Management any within their partner;
 * opndoor admin any. Never once Paid — post-payment exits are the refund flow.
 * The mark_withdrawn RPC enforces this rule independently.
 */
export function canWithdraw(role: Role, status: Status, ownedByReferrer: boolean): boolean {
  if (status !== 'sent') return false;
  return role === 'referrer' ? ownedByReferrer : true;
}

/**
 * Withdraw a Sent application with a reason (and a note when reason is 'other').
 * Persists via the mark_withdrawn RPC, which re-checks Sent-only + permission and
 * writes the activity-log entry with the actor and reason. No-op in mock mode
 * (the caller reflects the change in the demo view locally).
 */
export async function withdrawApplication(ref: string, reason: WithdrawReason, note: string): Promise<void> {
  if (!SUPABASE_ENABLED) {
    // #10 Mock/demo mode: mutate the working copies so every surface (detail pill/
    // banner, list row, chip, dashboard counter) reflects the withdrawal after the
    // caller's refresh() bumps dataVersion. Live mode persists via the RPC below and
    // re-hydrates instead.
    const rec = RECORDS.find((r) => r.ref === ref);
    if (rec) { rec.status = 'withdrawn'; rec.withdrawnReason = reason; }
    const row = LIST.find((r) => r.ref === ref);
    if (row) { row.status = 'withdrawn'; row.withdrawn = true; }
    return;
  }
  const { error } = await sb().rpc('mark_withdrawn', { p_ref: ref, p_reason: reason, p_note: note.trim() || null });
  if (error) throw new Error(error.message || 'Could not withdraw the application.');
}

export interface AmendResult {
  /** True after payment (Paid/Deed Issued): the deed is reissued. */
  reissued: boolean;
  /** New issue and expiry when reissued, otherwise null. */
  issue: Date | null;
  expiry: Date | null;
}

/**
 * Amend the tenancy start date. Any valid date is accepted; the form checks
 * that the input is a real dd/mm/yyyy date that differs from the current start.
 * Before payment (Sent) this just corrects the start date. After payment it
 * reissues the Deed of Guarantee and recomputes the 12-month expiry.
 * This computes the UI result only; amendTenancyStartDb persists the change via
 * the amend-tenancy-start Edge Function, which enforces the deed-state-aware
 * permission rule and orchestrates the reissue server-side.
 */
export function amendTenancyStart(status: Status, newStart: Date): AmendResult {
  if (status === 'sent') return { reissued: false, issue: null, expiry: null };
  // Reissue: the expiry recomputes from the new tenancy start (start + 12 months - 1 day).
  return { reissued: true, issue: new Date(2026, 5, 26), expiry: guaranteeExpiry(newStart) };
}
