/* =====================================================================
   Activity service — the consolidated activity feed and the upcoming-expiry
   read model, both scoped by role and partner (Referrers see their own,
   Management their partner's estate, opndoor admin everything).

   Live mode: getActivityFeed and getNotifications read the real activity_log
   (RLS-scoped, business-visibility) with true timestamps; getUpcomingExpiries
   reads the hydrated in-force guarantees. Mock/test mode: getActivity derives
   events deterministically from the mock applications, and getUpcomingExpiries
   reads the seed. Expiry always comes from guaranteeExpiry (tenancy start + 12
   months - 1 day) so no surface drifts.
   ===================================================================== */
import type { ActivityEntry, ActivityKind, ExpiryBand, PartnerScope, Role, UpcomingExpiry } from './types';
import { ALL_PARTNERS } from './types';
import { UPCOMING_GUARANTEES, type UpcomingGuaranteeSeed } from './mock/guarantees';
import { allSummaries, guaranteeExpiry } from './applicationsService';
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';

const DAY = 86400000;

// The demo "today" keeps the mock/test banding deterministic. In Supabase mode
// the real current date is used (the reminder job below also runs on real dates).
const DEMO_TODAY = new Date(2026, 5, 26);
function today(): Date {
  return SUPABASE_ENABLED ? new Date() : DEMO_TODAY;
}

// In-force guarantees approaching expiry. Seeded from the mock; replaced from
// Supabase after login (the near-term deed applications).
let UPCOMING: UpcomingGuaranteeSeed[] = UPCOMING_GUARANTEES;

/** Replace the upcoming-expiries source from the back end (Supabase mode). */
export function hydrateUpcoming(rows: UpcomingGuaranteeSeed[]): void {
  UPCOMING = rows.slice();
}

export interface ActivityScope {
  role: Role;
  scope: PartnerScope;
}

function parseISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY);
}

/** Role + partner isolation (mirrors the applications list rule). */
function inScope(opts: ActivityScope, row: { partner: string; owner: number }): boolean {
  if (opts.scope !== ALL_PARTNERS && row.partner !== opts.scope) return false;
  if (opts.role === 'referrer' && !row.owner) return false;
  return true;
}

/**
 * Consolidated, most-recent-first activity feed: referrals sent, guarantor
 * fees paid and deeds issued across the caller's scope. Event dates are
 * derived deterministically from each application's latest status, the same
 * way the application detail view does.
 */
export function getActivity(opts: ActivityScope): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  allSummaries().filter((r) => inScope(opts, r)).forEach((r) => {
    const event = parseISO(r.date);
    let sentAt: Date;
    let paidAt: Date | null = null;
    let deedAt: Date | null = null;
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
    const base = { ref: r.ref, tenant: r.tenant, prop: r.prop, branch: r.branch, agency: r.agency, partner: r.partner };
    const add = (kind: ActivityKind, at: Date) => entries.push({ id: `${r.ref}-${kind}`, kind, at, ...base });
    add('sent', sentAt);
    if (paidAt) add('paid', paidAt);
    if (deedAt) add('deed', deedAt);
  });
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime());
}

function bandFor(daysUntil: number): ExpiryBand {
  if (daysUntil <= 7) return 'soon';
  if (daysUntil <= 14) return 'warn';
  if (daysUntil <= 30) return 'notice';
  return 'later';
}

/**
 * Guarantees approaching expiry in the caller's scope, soonest first. Expiry
 * comes from guaranteeExpiry (tenancy start + 12 months - 1 day), so this view
 * and the reminder job below cannot drift.
 *
 * IMPLEMENTED: the scheduled back-end job is the expiry-reminders Edge Function
 * (pg_cron -> net.http_post daily, self-gated to 08:00 Europe/London). It fires a
 * reminder as daysUntil crosses 30, 14, 7, then daily from 6 to 0, recording each
 * (application, threshold) in expiry_reminders so it fires exactly once, delivered
 * as a business activity entry AND a branded Resend email to the owning referrer
 * and partner management. The per-guarantee count surfaces as remindersSent here.
 * See supabase/functions/expiry-reminders and supabase/EXPIRY-REMINDERS.md.
 */
export function getUpcomingExpiries(opts: ActivityScope): UpcomingExpiry[] {
  const now = today();
  return UPCOMING.filter((g) => inScope(opts, g))
    .map((g) => {
      const expiry = guaranteeExpiry(parseISO(g.tenancyStart));
      const daysUntil = Math.round((expiry.getTime() - now.getTime()) / DAY);
      return { ref: g.ref, tenant: g.tenant, prop: g.prop, branch: g.branch, agency: g.agency, partner: g.partner, expiry, daysUntil, band: bandFor(daysUntil), remindersSent: g.remindersSent ?? 0 };
    })
    .filter((e) => e.daysUntil >= 0) // upcoming only
    .sort((a, b) => a.expiry.getTime() - b.expiry.getTime());
}

/* ---------- Topbar notifications ---------- */

export interface NotificationItem {
  ref: string;
  text: string;
  dot: 'sent' | 'paid' | 'deed' | 'other';
  /** Pre-formatted honest relative time (live), or the demo string (mock). */
  time: string;
}

// Mock/test mode keeps the illustrative demo entries.
const DEMO_NOTIFICATIONS: NotificationItem[] = [
  { ref: 'GR-20455', text: 'Chen Wei reached Paid', dot: 'paid', time: '14 minutes ago' },
  { ref: 'GR-20418', text: 'Deed issued for Amelia Hartley', dot: 'deed', time: '1 hour ago' },
  { ref: 'GR-20518', text: 'New referral sent to Omar Farouk', dot: 'sent', time: '3 hours ago' },
];

const NOTIF_KINDS = ['referral_created', 'payment_received', 'deed_sent', 'deed_signed', 'deed_issued', 'refunded', 'expiry_reminder'];

function relTime(at: Date): string {
  const mins = Math.round((Date.now() - at.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return `${Math.round(days / 7)} week${Math.round(days / 7) === 1 ? '' : 's'} ago`;
}

function notifLabel(kind: string, tenant: string): { text: string; dot: NotificationItem['dot'] } {
  switch (kind) {
    case 'referral_created': return { text: `New referral sent to ${tenant}`, dot: 'sent' };
    case 'payment_received': return { text: `${tenant} reached Paid`, dot: 'paid' };
    case 'deed_sent': return { text: `Deed sent for signature to ${tenant}`, dot: 'sent' };
    case 'deed_signed':
    case 'deed_issued': return { text: `Deed issued for ${tenant}`, dot: 'deed' };
    case 'refunded': return { text: `Guarantor fee refunded for ${tenant}`, dot: 'other' };
    case 'expiry_reminder': return { text: `Guarantee expiring for ${tenant}`, dot: 'other' };
    default: return { text: `Update for ${tenant}`, dot: 'other' };
  }
}

/**
 * Recent notifications for the signed-in viewer. Live mode reads the real
 * activity_log, scoped exactly by RLS (own referrals for a Referrer, partner for
 * Management, all for admin) and to business-visibility milestones, with honest
 * relative times. Mock/test mode keeps the demo entries. Never shows another
 * partner's data.
 */
export async function getNotifications(): Promise<NotificationItem[]> {
  if (!SUPABASE_ENABLED) return DEMO_NOTIFICATIONS;
  // Fetch a wider window than we show so that collapsing repeat events (e.g. a
  // deed regenerated several times) still leaves a full panel of distinct items.
  const { data, error } = await sb()
    .from('activity_log')
    .select('kind, at, application:applications!inner(guarantee_ref, tenant_first_name, tenant_last_name)')
    .eq('visibility', 'business')
    .in('kind', NOTIF_KINDS)
    .order('at', { ascending: false })
    .limit(40);
  if (error || !data) return [];
  const out: NotificationItem[] = [];
  let prevKey = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of data as any[]) {
    const app = row.application;
    if (!app?.guarantee_ref) continue;
    // Collapse consecutive same-kind entries for the same application to the
    // latest (rows are newest-first, so the first occurrence is the one kept).
    const key = `${app.guarantee_ref}:${row.kind}`;
    if (key === prevKey) continue;
    prevKey = key;
    const tenant = `${app.tenant_first_name ?? ''} ${app.tenant_last_name ?? ''}`.trim() || app.guarantee_ref;
    const { text, dot } = notifLabel(row.kind, tenant);
    out.push({ ref: app.guarantee_ref, text, dot, time: relTime(new Date(row.at)) });
    if (out.length >= 8) break;
  }
  return out;
}

/* ---------- Activity page feed (live: sourced from activity_log) ---------- */

export interface ActivityFeedItem {
  id: string;
  ref: string;
  tenant: string;
  branch: string;
  agency: string;
  /** Raw activity_log kind (the page maps it to a label + dot). */
  kind: string;
  /** The real event timestamp. */
  at: Date;
}

// Business milestones shown on the Activity page. Lower-signal internal/system
// noise (email sends, reminders, raw failures) is intentionally excluded here.
const FEED_KINDS = [
  'referral_created', 'payment_received', 'refunded',
  'deed_sent', 'deed_viewed', 'deed_signed', 'deed_issued',
  'deed_regenerated', 'deed_reissued', 'tenancy_amended',
];

/**
 * Live activity feed for the Activity page, sourced from the same canonical
 * activity_log as the detail-page feed, with the real timestamp on every row.
 * RLS scopes it to the viewer (own referrals / partner / all); only
 * business-visibility milestones are returned. Newest first. No derived dates.
 */
export async function getActivityFeed(opts: ActivityScope): Promise<ActivityFeedItem[]> {
  void opts; // scope is enforced by RLS, not re-applied here
  const { data, error } = await sb()
    .from('activity_log')
    .select('id, kind, at, application:applications!inner(guarantee_ref, tenant_first_name, tenant_last_name, branch:branches(name), agency:agencies(name))')
    .eq('visibility', 'business')
    .in('kind', FEED_KINDS)
    .order('at', { ascending: false })
    .limit(200);
  if (error || !data) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data as any[])
    .map((row) => {
      const app = row.application;
      if (!app?.guarantee_ref) return null;
      const tenant = `${app.tenant_first_name ?? ''} ${app.tenant_last_name ?? ''}`.trim() || app.guarantee_ref;
      const emb = (x: unknown) => (Array.isArray(x) ? x[0] : x) as { name?: string } | null;
      return {
        id: row.id, ref: app.guarantee_ref, tenant,
        branch: emb(app.branch)?.name ?? '', agency: emb(app.agency)?.name ?? '',
        kind: row.kind, at: new Date(row.at),
      } as ActivityFeedItem;
    })
    .filter((n): n is ActivityFeedItem => n !== null);
}
