/* =====================================================================
   Live analytics — every dashboard/league/export figure computed from the
   hydrated live application set (Supabase mode). Retires the synthetic model
   in real mode; mock/test mode still uses mock/analyticsModel via the callers.

   Basis (single, reconcilable): EVENT-IN-PERIOD. Each funnel stage counts
   applications by whether its own event fell in the period (Sent = sentAt,
   Paid = paidAt, Deed = deedAt). Fees collected = fees paid in the period
   (gross); commission = net of refunds; total guaranteed rent value =
   annualised rent over deeds issued in the period. This makes the funnel,
   KPIs, charts, league and exports all reconcile to the same live events, and
   matches the Live payments block. Conversion rates are therefore period
   throughput ratios (stage-in-period / prior-stage-in-period), not sent-cohort
   tracked, so they can exceed 100% in a period dominated by deferred payments.

   Commission uses each application's SNAPSHOTTED per-partner rates (app.partnerRate
   / app.agentRate, frozen at creation), never the partner's live rate, so editing
   a partner's rate never moves historical figures. It is net of refunds: gross
   commission on fees paid in the period, minus the commission on fees refunded in
   the period. For a single-partner scope this equals feesNet x rate (the Live
   payments block's presentation).
   ===================================================================== */
import { SUPABASE_ENABLED } from '@/lib/supabase';
import type { LeagueRow, LeagueView, PartnerScope, Period, Role } from './types';
import { ALL_PARTNERS } from './types';
import { allFull, guaranteeExpiry, isHydrated, type FullApp } from './applicationsService';
import { getPartners, partnerName } from './partnersService';
import { contactForApplication } from './orgService';
import { periodRange, scopeFull, inRange } from './paymentMetrics';

const DAY = 86_400_000;
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * True when live analytics should be used: Supabase mode AND the live set has
 * been hydrated. Keyed on hydration, not on row count, so a genuinely empty
 * scope renders honest zeros instead of silently reverting to the mock model.
 */
export function liveAvailable(): boolean {
  return SUPABASE_ENABLED && isHydrated();
}

/** "Now" — real in Supabase mode; the fixed demo date otherwise (parity with periodRange). */
function nowRef(): Date {
  return SUPABASE_ENABLED ? new Date() : new Date(2026, 5, 26);
}

/** Display label for a referring user's actual role (league attribution). */
function roleLabel(role: Role | null | undefined): string {
  if (role === 'superadmin') return 'opndoor admin';
  if (role === 'management') return 'Management';
  return 'Referrer';
}

export interface LiveAgg {
  sent: number;
  paid: number;
  deed: number;
  feesGross: number;
  refundValue: number;
  refundCount: number;
  feesNet: number;
  guaranteed: number; // annualised rent over deeds issued in the period
  partnerCommNet: number;
  agentCommNet: number;
  partnerCommExcl: number; // commission excluded because the fee was refunded (in period)
  agentCommExcl: number;
  // Current-state operational metrics (whole scoped book, not period-filtered)
  stuckSent: number;
  stuckPaid: number;
  awaiting: number; // deeds awaiting tenant signature
  awaitingAged: number; // ... unsigned more than 7 days
  avgRent: number;
  avgSentToPaidDays: number | null;
  avgPaidToDeedDays: number | null;
  bookSize: number; // scoped applications total
}

/** Aggregate the scoped set for a period (event-in-period money/counts + current-state ops). */
export function liveAggregate(role: Role, scope: PartnerScope, period: Period): LiveAgg {
  const [start, end] = periodRange(period);
  // #2 Withdrawn is terminal and pre-payment: it leaves the funnel entirely, so
  // it is excluded from every count, conversion denominator, ops metric and
  // average here (never inside Sent, never in stuck-at-Sent).
  const set = scopeFull(allFull(), role, scope).filter((x) => !x.withdrawn);
  const a: LiveAgg = {
    sent: 0, paid: 0, deed: 0, feesGross: 0, refundValue: 0, refundCount: 0, feesNet: 0,
    guaranteed: 0, partnerCommNet: 0, agentCommNet: 0, partnerCommExcl: 0, agentCommExcl: 0,
    stuckSent: 0, stuckPaid: 0, awaiting: 0, awaitingAged: 0, avgRent: 0,
    avgSentToPaidDays: null, avgPaidToDeedDays: null, bookSize: set.length,
  };
  let rentSum = 0;
  let s2pSum = 0, s2pN = 0, p2dSum = 0, p2dN = 0;
  const now = nowRef().getTime();
  for (const app of set) {
    const r = { partner: app.partnerRate, agent: app.agentRate };
    rentSum += app.rent;
    if (inRange(app.sentAt, start, end)) a.sent += 1;
    if (inRange(app.paidAt, start, end)) {
      // A fee is attributed to the period it was PAID; a refunded application
      // earns no net commission (identical to the per-row Application export, so
      // every commission figure reconciles). Refund amount reduces net fees.
      a.paid += 1;
      a.feesGross += app.rent;
      if (app.refunded) {
        a.refundCount += 1;
        a.refundValue += app.refundedAmount ?? app.rent;
        a.partnerCommExcl += app.rent * r.partner;
        a.agentCommExcl += app.rent * r.agent;
      } else {
        a.partnerCommNet += app.rent * r.partner;
        a.agentCommNet += app.rent * r.agent;
      }
    }
    if (inRange(app.deedAt, start, end)) { a.deed += 1; a.guaranteed += app.rent * 12; }
    // Current-state operational metrics (not period-filtered).
    if (app.status === 'sent') a.stuckSent += 1;
    if (app.status === 'paid' && !app.deedAt && !app.refunded) a.stuckPaid += 1;
    if (app.deedState === 'awaiting_tenant') {
      a.awaiting += 1;
      if (app.deedSentAt && (now - app.deedSentAt.getTime()) / DAY > 7) a.awaitingAged += 1;
    }
    if (app.sentAt && app.paidAt) { s2pSum += (app.paidAt.getTime() - app.sentAt.getTime()) / DAY; s2pN += 1; }
    if (app.paidAt && app.deedAt) { p2dSum += (app.deedAt.getTime() - app.paidAt.getTime()) / DAY; p2dN += 1; }
  }
  a.feesNet = a.feesGross - a.refundValue;
  a.avgRent = set.length ? rentSum / set.length : 0;
  a.avgSentToPaidDays = s2pN ? s2pSum / s2pN : null;
  a.avgPaidToDeedDays = p2dN ? p2dSum / p2dN : null;
  return a;
}

/** Deeds issued (status Deed) with no resolvable claim contact (branch -> agency
    default) - i.e. the deed could not be delivered to the agent. Surfaced in the
    dashboard needs-attention row so an undeliverable deed never goes unnoticed. */
export function deedsWithoutContact(role: Role, scope: PartnerScope): number {
  const set = scopeFull(allFull(), role, scope);
  let n = 0;
  for (const app of set) {
    if (app.status === 'deed' && !contactForApplication(app.agency, app.branch).contact) n += 1;
  }
  return n;
}

/** #86 In-force guarantees expiring within the next 14 days (already-expired
    excluded), the slippage tripwire for the needs-attention row. */
export function lapsingWithin14(role: Role, scope: PartnerScope): number {
  const set = scopeFull(allFull(), role, scope);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const in14 = new Date(today);
  in14.setDate(in14.getDate() + 14);
  let n = 0;
  for (const app of set) {
    if (app.status !== 'deed' || app.refunded) continue;
    const exp = app.expiry ?? (app.tenancyStart ? guaranteeExpiry(app.tenancyStart) : null);
    if (exp && exp >= today && exp <= in14) n += 1; // expired excluded (exp >= today)
  }
  return n;
}

/** Per-group accumulator, emitted as a LeagueRow. */
interface Group {
  name: string;
  sub: string;
  partner?: string;
  refs: number; paid: number; deed: number;
  feesGross: number; refundValue: number;
  partnerComm: number; agentComm: number;
  partnerCommExcl: number; agentCommExcl: number;
}

function emit(g: Group): LeagueRow {
  return {
    name: g.name,
    sub: g.sub,
    partner: g.partner,
    refs: g.refs,
    fees: g.feesGross, // "Fees collected" is gross; commission below is net of refunds
    paid: g.paid,
    deed: g.deed,
    sp: g.refs ? g.paid / g.refs : 0,
    conv: g.refs ? g.deed / g.refs : 0,
    partnerComm: g.partnerComm, // already net: refunded applications are excluded below
    agentComm: g.agentComm,
  };
}

type GroupKey = 'agency' | 'branch' | 'referrer' | 'month';

/** A stable identity for the group (so distinct entities that share a display
    name — e.g. a "High Street" branch under two agencies — are never merged). */
function keyOf(app: FullApp, key: GroupKey, monthLabel: (d: Date) => string): { id: string; name: string; sub: string; partner: string } | null {
  const S = ' ';
  const pn = partnerName(app.partner);
  if (key === 'agency') return { id: `${app.partner}${S}${app.agency}`, name: app.agency || '(unknown agency)', sub: '', partner: pn };
  if (key === 'branch') return { id: `${app.partner}${S}${app.agency}${S}${app.branch}`, name: app.branch || '(unknown branch)', sub: app.agency || '', partner: pn };
  if (key === 'referrer') {
    // opndoor internal staff never appear in referrer performance rankings (League
    // Referrers, dashboard volume-by-referrer, export breakdown, by-referrer trend).
    // Their applications remain fully real in every other surface (money,
    // settlements, agency/branch groupings, exports).
    if (app.referrerRole === 'superadmin') return null;
    return { id: `${app.partner}${S}${app.referrer}`, name: app.referrer || '(unknown)', sub: roleLabel(app.referrerRole), partner: '' };
  }
  // month: bucket by the sent month (drives the referrer "monthly volume" chart)
  if (!app.sentAt) return null;
  const lbl = monthLabel(app.sentAt);
  return { id: lbl, name: lbl, sub: '', partner: '' };
}

/** Group the scoped set into ranked LeagueRows by agency / branch / referrer / month. */
function groupRows(set: FullApp[], key: GroupKey, start: Date, end: Date): LeagueRow[] {
  const monthLabel = (d: Date) => `${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
  const map = new Map<string, Group>();
  const get = (id: string, name: string, sub: string, partner: string): Group => {
    let g = map.get(id);
    if (!g) { g = { name, sub, partner, refs: 0, paid: 0, deed: 0, feesGross: 0, refundValue: 0, partnerComm: 0, agentComm: 0, partnerCommExcl: 0, agentCommExcl: 0 }; map.set(id, g); }
    return g;
  };
  for (const app of set) {
    // #2 Withdrawn is terminal and excluded from every league/volume figure
    // (refs, conversion, fees), matching liveAggregate's funnel exclusion.
    if (app.withdrawn) continue;
    const k = keyOf(app, key, monthLabel);
    if (!k) continue;
    const r = { partner: app.partnerRate, agent: app.agentRate };
    const sentIn = inRange(app.sentAt, start, end);
    const paidIn = inRange(app.paidAt, start, end);
    const deedIn = inRange(app.deedAt, start, end);
    if (!sentIn && !paidIn && !deedIn) continue; // nothing in period for this entity
    const g = get(k.id, k.name, k.sub, k.partner);
    if (sentIn) g.refs += 1;
    if (paidIn) {
      // Same rule as liveAggregate: refunded application earns no net commission.
      g.paid += 1; g.feesGross += app.rent;
      if (app.refunded) { g.refundValue += app.refundedAmount ?? app.rent; g.partnerCommExcl += app.rent * r.partner; g.agentCommExcl += app.rent * r.agent; }
      else { g.partnerComm += app.rent * r.partner; g.agentComm += app.rent * r.agent; }
    }
    if (deedIn) g.deed += 1;
  }
  const rows = [...map.values()].map(emit);
  // Months sort chronologically (most recent first); entities sort by fees.
  if (key === 'month') return rows.sort((x, y) => monthOrder(y.name) - monthOrder(x.name));
  return rows.sort((x, y) => y.fees - x.fees || y.refs - x.refs);
}

function monthOrder(label: string): number {
  const [abbr, yr] = label.split(' ');
  return Number(yr) * 12 + MONTH_ABBR.indexOf(abbr);
}

/** Live volume rows for the three dashboard charts (full lists; callers take top-N). */
export function liveVolume(role: Role, scope: PartnerScope, period: Period): { branches: LeagueRow[]; agencies: LeagueRow[]; referrers: LeagueRow[] } {
  const [start, end] = periodRange(period);
  const set = scopeFull(allFull(), role, scope);
  const isRef = role === 'referrer';
  return {
    branches: groupRows(set, 'branch', start, end),
    agencies: groupRows(set, 'agency', start, end),
    // A referrer's own third chart is their monthly volume; everyone else's is by referrer.
    referrers: groupRows(set, isRef ? 'month' : 'referrer', start, end),
  };
}

/** Live league rows for one view (agency/branch/referrer), period + scope filtered. */
export function liveLeague(view: LeagueView, role: Role, scope: PartnerScope, partner: string, period: Period): LeagueRow[] {
  const [start, end] = periodRange(period);
  // opndoor admin's in-page partner filter narrows an all-partners scope to one.
  const effScope: PartnerScope = scope === ALL_PARTNERS && partner ? partner : scope;
  const set = scopeFull(allFull(), role, effScope);
  return groupRows(set, view, start, end);
}

export interface MonthRow { label: string; refs: number; fees: number; deeds: number; comm: number; }

/** Trailing-12-month buckets: referrals sent, gross fees paid, deeds issued, and
    net partner commission (per-application rates, refunded apps excluded) per
    month. Fees are gross (collected), matching the volume/league basis. */
export function liveMonths(role: Role, scope: PartnerScope): MonthRow[] {
  const set = scopeFull(allFull(), role, scope);
  const end = nowRef();
  const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
  const months: (MonthRow & { key: number })[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    months.push({ label: `${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`, key: d.getFullYear() * 12 + d.getMonth(), refs: 0, fees: 0, deeds: 0, comm: 0 });
  }
  const lo = months[0].key, hi = months[11].key;
  const idx = (d: Date) => d.getFullYear() * 12 + d.getMonth();
  const at = (d: Date) => months.find((x) => x.key === idx(d));
  for (const app of set) {
    if (app.withdrawn) continue; // #2 terminal: excluded from trailing-12-month volume/fees
    if (app.sentAt && idx(app.sentAt) >= lo && idx(app.sentAt) <= hi) { const m = at(app.sentAt); if (m) m.refs += 1; }
    if (app.paidAt && idx(app.paidAt) >= lo && idx(app.paidAt) <= hi) {
      const m = at(app.paidAt);
      if (m) { m.fees += app.rent; if (!app.refunded) m.comm += app.rent * app.partnerRate; }
    }
    if (app.deedAt && idx(app.deedAt) >= lo && idx(app.deedAt) <= hi) { const m = at(app.deedAt); if (m) m.deeds += 1; }
  }
  return months.map((m) => ({ label: m.label, refs: m.refs, fees: Math.round(m.fees), deeds: m.deeds, comm: Math.round(m.comm) }));
}

/* ---------- Partner commission settlement ----------
   Commission accrues on the payment date (calendar-month buckets, matching the
   per-application net-of-refunds rule) and is settled on the 15th of the
   following month. This answers, for the prior calendar month, exactly what is
   payable to each partner and which applications make it up. */
export interface SettlementApp { ref: string; agency: string; branch: string; paidAt: Date; rent: number; commission: number; }
export interface PartnerSettlement { partner: string; partnerName: string; commission: number; apps: SettlementApp[]; }
export interface CommissionSettlement { monthLabel: string; settlementDate: Date; partners: PartnerSettlement[]; }

/** Partner commission payable on the 15th of this month, for the prior calendar
    month (net of refunds), broken down per partner with constituent apps. */
export function getCommissionSettlement(role: Role, scope: PartnerScope): CommissionSettlement {
  const now = nowRef();
  const bStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const bEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999); // last day of prior month
  const settlementDate = new Date(now.getFullYear(), now.getMonth(), 15); // 15th of this month
  const monthLabel = `${MONTH_LONG[bStart.getMonth()]} ${bStart.getFullYear()}`;
  const set = scopeFull(allFull(), role, scope);
  const byPartner = new Map<string, PartnerSettlement>();
  for (const a of set) {
    if (!inRange(a.paidAt, bStart, bEnd)) continue;
    if (a.refunded) continue; // net of refunds: a refunded application earns no commission
    const commission = a.rent * a.partnerRate;
    let ps = byPartner.get(a.partner);
    if (!ps) { ps = { partner: a.partner, partnerName: partnerName(a.partner), commission: 0, apps: [] }; byPartner.set(a.partner, ps); }
    ps.commission += commission;
    ps.apps.push({ ref: a.ref, agency: a.agency, branch: a.branch, paidAt: a.paidAt!, rent: a.rent, commission });
  }
  const partners = [...byPartner.values()].sort((x, y) => y.commission - x.commission);
  partners.forEach((p) => p.apps.sort((x, y) => y.commission - x.commission));
  return { monthLabel, settlementDate, partners };
}

/* ---------- Per-partner commission breakdown (selected period) ----------
   Commission accrues on the payment date; each row is one partner with its
   partner-side and agent-side commission, both gross and net of refunds. The
   net columns sum to the summary's partnerCommNet / agentCommNet, so the table
   reconciles to the headline totals. */
export interface PartnerCommissionRow {
  partner: string;
  partnerName: string;
  paid: number;
  feesGross: number;
  refundValue: number;
  partnerCommGross: number;
  partnerCommNet: number;
  agentCommGross: number;
  agentCommNet: number;
}

export function livePartnerBreakdown(role: Role, scope: PartnerScope, period: Period): PartnerCommissionRow[] {
  const [start, end] = periodRange(period);
  const set = scopeFull(allFull(), role, scope);
  const map = new Map<string, PartnerCommissionRow>();
  for (const app of set) {
    if (!inRange(app.paidAt, start, end)) continue; // commission attributed to the payment period
    const r = { partner: app.partnerRate, agent: app.agentRate };
    let row = map.get(app.partner);
    if (!row) {
      row = { partner: app.partner, partnerName: partnerName(app.partner), paid: 0, feesGross: 0, refundValue: 0,
        partnerCommGross: 0, partnerCommNet: 0, agentCommGross: 0, agentCommNet: 0 };
      map.set(app.partner, row);
    }
    row.paid += 1;
    row.feesGross += app.rent;
    row.partnerCommGross += app.rent * r.partner;
    row.agentCommGross += app.rent * r.agent;
    if (app.refunded) {
      row.refundValue += app.refundedAmount ?? app.rent;
    } else {
      row.partnerCommNet += app.rent * r.partner;
      row.agentCommNet += app.rent * r.agent;
    }
  }
  // #85 Under All-partners scope, list every active partner even with no paid
  // referrals in the period, so a partner never silently vanishes ("ghost").
  // Paused/onboarding partners with no activity stay hidden (noted in the caption).
  if (scope === ALL_PARTNERS) {
    for (const p of getPartners()) {
      if (p.status === 'active' && !map.has(p.id)) {
        map.set(p.id, { partner: p.id, partnerName: p.name, paid: 0, feesGross: 0, refundValue: 0,
          partnerCommGross: 0, partnerCommNet: 0, agentCommGross: 0, agentCommNet: 0 });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.partnerCommNet - a.partnerCommNet);
}

/* ---------- Agent commission settlement ----------
   Mirrors the partner settlement, but for the agent share, aggregated at AGENCY
   level (the agent commission is payable to the letting agency): prior calendar
   month accrual on the payment date, net of refunds, payable the 15th, with the
   constituent applications listed. */
export interface AgentSettlementAgency { agency: string; partner: string; partnerName: string; commission: number; apps: SettlementApp[]; }
export interface AgentCommissionSettlement { monthLabel: string; settlementDate: Date; agencies: AgentSettlementAgency[]; }

export function getAgentCommissionSettlement(role: Role, scope: PartnerScope): AgentCommissionSettlement {
  const now = nowRef();
  const bStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const bEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const settlementDate = new Date(now.getFullYear(), now.getMonth(), 15);
  const monthLabel = `${MONTH_LONG[bStart.getMonth()]} ${bStart.getFullYear()}`;
  const set = scopeFull(allFull(), role, scope);
  const byAgency = new Map<string, AgentSettlementAgency>();
  for (const a of set) {
    if (!inRange(a.paidAt, bStart, bEnd)) continue;
    if (a.refunded) continue; // net of refunds
    const commission = a.rent * a.agentRate;
    // Key by partner + agency so same-named agencies under different partners never merge.
    const key = `${a.partner}${a.agency}`;
    let ag = byAgency.get(key);
    if (!ag) { ag = { agency: a.agency || '(unknown agency)', partner: a.partner, partnerName: partnerName(a.partner), commission: 0, apps: [] }; byAgency.set(key, ag); }
    ag.commission += commission;
    ag.apps.push({ ref: a.ref, agency: a.agency, branch: a.branch, paidAt: a.paidAt!, rent: a.rent, commission });
  }
  const agencies = [...byAgency.values()].sort((x, y) => y.commission - x.commission);
  agencies.forEach((a) => a.apps.sort((x, y) => y.commission - x.commission));
  return { monthLabel, settlementDate, agencies };
}

export interface TrendRow { label: string; count: number; fees: number; comm: number; sub?: string; }

/** Live 12-month trend: by-month or an entity breakdown, carrying real net
    partner commission (per-application rates) so it reconciles with the KPIs. */
export function liveTrend(view: 'month' | 'branch' | 'agency' | 'referrer', role: Role, scope: PartnerScope): TrendRow[] {
  if (view === 'month') return liveMonths(role, scope).map((m) => ({ label: m.label, count: m.refs, fees: m.fees, comm: m.comm }));
  const set = scopeFull(allFull(), role, scope);
  const end = nowRef();
  const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
  return groupRows(set, view, start, end).map((r) => ({ label: r.name, count: r.refs, fees: Math.round(r.fees), comm: Math.round(r.partnerComm), sub: r.sub || undefined }));
}
