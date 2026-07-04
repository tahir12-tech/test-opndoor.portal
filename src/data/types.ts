/* =====================================================================
   Domain types for the Guarantee Referral Portal.
   These mirror the data model in HANDOFF.md section 6. The service layer
   (src/data/*) returns these shapes today from mock data; a real back end
   would return the same shapes from API calls.
   ===================================================================== */

/** The three portal roles. "superadmin" is opndoor admin in code. */
export type Role = 'superadmin' | 'management' | 'referrer';

/** A partner id, or the special "all partners combined" scope (opndoor admin only). */
export type PartnerScope = string;
export const ALL_PARTNERS = 'all';

/** Application lifecycle. */
export type Status = 'sent' | 'paid' | 'deed';
/** Deed sub-state while Paid (DB-enforced set), or null before a deed exists. */
export type DeedState = 'awaiting_tenant' | 'executed' | 'declined' | 'voided' | 'error';
/** Guarantor-fee payment state (DB-enforced set). */
export type PaymentState = 'awaiting' | 'paid' | 'refunded';
export type PartnerStatus = 'active' | 'onboarding' | 'paused';
export type UserStatus = 'active' | 'pending' | 'deactivated';

/* ---------- Partner ---------- */
export interface Partner {
  id: string;
  name: string;
  status: PartnerStatus;
  /** Live-from month, e.g. "2024-09". */
  since: string;
  /** Demo analytics weight; a real back end would sum real records instead. */
  weight: number;
  primary?: boolean;
  users: number;
  apps: number;
  /** Per-partner commission rates (fractions of one month's rent). Never hard-coded. */
  partnerRate: number;
  agentRate: number;
}

export interface CommissionRates {
  partner: number;
  agent: number;
}

/* ---------- Organisation hierarchy ---------- */

/**
 * An agent contact on an agency or a branch. Exactly one is primary per owner.
 * A branch with no contacts inherits the parent agency's (see effectiveContacts).
 */
export interface AgentContact {
  /** DB row id (Supabase mode). Absent in mock/test mode. */
  id?: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  primary: boolean;
}

export interface Branch {
  /** DB row id (Supabase mode). Absent in mock/test mode. */
  id?: string;
  name: string;
  area: string;
  referrers?: number;
  referrals: number;
  guaranteed: string;
  fees?: number;
  contacts?: AgentContact[];
  /** Set when a referrer created this on the fly; surfaced in reconciliation. */
  unreviewed?: boolean;
}

export interface Agency {
  /** DB row id (Supabase mode). Absent in mock/test mode. */
  id?: string;
  /** Owning partner id. The same name under two partners is two records. */
  partner: string;
  name: string;
  group?: string;
  users?: number;
  referrals: number;
  guaranteed: string;
  fees?: number;
  contacts?: AgentContact[];
  /** UI expand state (seeded so the primary agency starts open). */
  open?: boolean;
  branches: Branch[];
  unreviewed?: boolean;
}

/* ---------- User ---------- */
export interface User {
  name: string;
  /** Work email (real in Supabase mode; derived in mock mode). */
  email: string;
  role: Role;
  lastActive: string;
  status: UserStatus;
  /** Partner id, or "opndoor" for opndoor admin staff (who belong to no partner). */
  partner: string;
}

/* ---------- Application (referral) ---------- */
export interface ApplicationSummary {
  ref: string;
  tenant: string;
  prop: string;
  branch: string;
  agency: string;
  /** Legacy beneficiary label retained for search only; the deed is in favour of the property. */
  ben: string;
  rent: number;
  status: Status;
  date: string; // ISO yyyy-mm-dd (the anchor event's day, for display)
  /**
   * Anchor event time in epoch ms (deed issued, else paid, else sent), for a
   * genuinely newest-first sort that is deterministic to the second. Omitted on
   * legacy mock rows; callers fall back to `date`.
   */
  eventTs?: number;
  /** 1 when the demo referrer (Priya Nair) owns this referral. */
  owner: number;
  partner: string;
  /** True when the guarantor fee was refunded (status stays Paid, by design). */
  refunded?: boolean;
  /** True when the deed is out for signature (deed_state 'awaiting_tenant'); a
      sub-state of Paid, filterable from the list and the dashboard. */
  awaitingSignature?: boolean;
}

/** Display-ready record for the detail view (see applicationsService.getApplicationDetail). */
export interface ApplicationDetail {
  ref: string;
  status: Status;
  statusLabel: string;
  name: string;
  initials: string;
  title: string;
  role: string;
  fullName: string;
  dob: string;
  email: string;
  phone: string;
  addr1: string;
  addr2: string;
  city: string;
  county: string;
  postcode: string;
  agency: string;
  branch: string;
  agentAddr: string;
  rent: string;
  rentNum: number;
  referrer: string;
  tenancyStart: string;
  tenancyStartDate: Date;
  sentAt: Date;
  paidAt: Date | null;
  deedAt: Date | null;
  sentStr: string;
  paidStr: string | null;
  deedStr: string | null;
  issue: string | null;
  expiry: string | null;
  annual: string;
  paymentDate: Date | null;
  /** 1 when the signed-in demo referrer owns this referral (for amend scoping). */
  owner: number;
  /** True when the requested reference does not exist or is not accessible to
      the viewer (RLS returned nothing). The detail page renders an honest
      not-found state rather than substituting another record. */
  notFound?: boolean;
}

/* ---------- Help & resources ---------- */
export interface HelpResource {
  id: string;
  icon: string;
  type: string;
  title: string;
  desc: string;
  meta: string;
  href?: string;
  file?: { name: string; url: string; mime: string };
}
export interface HelpFaq {
  id: string;
  q: string;
  a: string;
}
export interface HelpManager {
  id: string;
  name: string;
  role: string;
  email: string;
  phone: string;
}
export interface HelpContent {
  gettingStarted: HelpResource[];
  templates: HelpResource[];
  faqs: HelpFaq[];
  managers: HelpManager[];
}
export type HelpResourceSection = 'gettingStarted' | 'templates';

/* ---------- Analytics ---------- */
export interface Period {
  id: string;
  label: string;
  fSent: number;
  sp: number;
  pd: number;
}

/* ---------- Activity feed + upcoming expiries ---------- */
export type ActivityKind = 'sent' | 'paid' | 'deed';
export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  ref: string;
  tenant: string;
  prop: string;
  branch: string;
  agency: string;
  partner: string;
  at: Date;
}

/** Urgency bands for an approaching expiry (mutually exclusive ranges). */
export type ExpiryBand = 'soon' | 'warn' | 'notice' | 'later';
export interface UpcomingExpiry {
  ref: string;
  tenant: string;
  prop: string;
  branch: string;
  agency: string;
  partner: string;
  expiry: Date;
  /** Whole days from today to the expiry date (>= 0 for upcoming). */
  daysUntil: number;
  band: ExpiryBand;
  /** Expiry reminders already sent for this guarantee (live mode; 0 in mock). */
  remindersSent: number;
}

/* ---------- League tables ---------- */
export type LeagueView = 'agency' | 'branch' | 'referrer';
export interface LeagueRow {
  name: string;
  sub: string;
  /** Owning partner display name, for the Partner column shown in All-partners scope. */
  partner?: string;
  refs: number;
  fees: number;
  paid: number;
  deed: number;
  /** Sent-to-Paid conversion (fraction). */
  sp: number;
  /** Sent-to-Deed conversion (fraction). */
  conv: number;
  /** Partner commission (per-partner rate applied to fees). */
  partnerComm: number;
  /** Agent commission (per-partner rate applied to fees). */
  agentComm: number;
}
