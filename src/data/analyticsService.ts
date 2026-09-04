/* =====================================================================
   Analytics service.
   Produces every dashboard figure — funnel, conversions, guaranteed value,
   fees, commission, the volume breakdowns and the 12-month trend.

   In Supabase mode (liveAvailable) every figure is computed from the hydrated
   live application set via liveAnalytics, period-filtered by real dates and
   scoped by role/partner. In mock/test mode the deterministic parametric model
   (mock/analyticsModel) is used so the smoke suite stays meaningful. The split
   follows the established SUPABASE_ENABLED pattern.
   ===================================================================== */
import type { LeagueRow, Period, PartnerScope, Role } from './types';
import { fmtRatePct } from '@/lib/format';
import { ALL_PARTNERS } from './types';
import { KEYS, loadString, saveString } from './storage';
import {
  ANNUAL, AVG_RENT, BASE_PAID_FULL, BASE_PAID_REF, BASE_SENT_FULL, BASE_SENT_REF,
  DEFAULT_PERIOD, PERIODS, REF_FRACTION, SHAPE_FULL, SHAPE_REF, TREND_MONTHS,
  convFor, scaleRows, type PeriodDef, type ShapeRow,
} from './mock/analyticsModel';
import { getRatesFor, weightFor } from './partnersService';
import { liveAvailable, liveAggregate, liveVolume, liveTrend, deedsWithoutContact, lapsingWithin14, type LiveAgg, type TrendRow } from './liveAnalytics';
export type { TrendRow } from './liveAnalytics';
export { getCommissionSettlement, getAgentCommissionSettlement, livePartnerBreakdown } from './liveAnalytics';
export type { CommissionSettlement, PartnerSettlement, SettlementApp, AgentCommissionSettlement, AgentSettlementAgency, PartnerCommissionRow } from './liveAnalytics';

export function getPeriods(): Period[] {
  return PERIODS.map((p) => ({ ...p }));
}

export function getSelectedPeriod(): Period {
  const id = loadString(KEYS.period);
  return PERIODS.find((p) => p.id === id) || PERIODS.find((p) => p.id === DEFAULT_PERIOD)!;
}

export function setSelectedPeriod(id: string): void {
  saveString(KEYS.period, id);
}

function fmtMoney(n: number): string {
  return `£${Math.round(n).toLocaleString('en-GB')}`;
}
function signedNeg(n: number): string {
  return n ? `- ${fmtMoney(n)}` : fmtMoney(0);
}
function pct(n: number, d: number): string {
  return `${d ? Math.round((n / d) * 100) : 0}%`;
}
function days(n: number | null): string {
  return n == null ? '—' : `${n.toFixed(1)}`;
}
export function fmtBig(n: number): string {
  if (n >= 1e6) return `£${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `£${Math.round(n / 1e3)}k`;
  return `£${Math.round(n)}`;
}

export interface DashboardModel {
  sub: string;
  funnelScope: string;
  sent: string;
  paid: string;
  deed: string;
  sp: string;
  pd: string;
  overall: string;
  guaranteed: string;
  deedcount: string;
  fees: string;
  commTag: string;
  commHeadline: string;
  commSecondLbl: string;
  commSecondVal: string;
  rent: string;
  stuckSent: string;
  stuckPaid: string;
  avgSentToPaid: string;
  avgPaidToDeed: string;
  branchScope: string;
  agencyScope: string;
  referrerTitle: string;
  referrerScope: string;
  branches: LeagueRow[];
  agencies: LeagueRow[];
  referrers: LeagueRow[];
  /** True when computed from live records (drives the folded gross/refunds/net presentation). */
  live: boolean;
  /** Live payment breakdown, folded into the KPI cards (meaningful only when live). */
  feesGross: string;
  refunds: string;
  refundCount: number;
  net: string;
  commExcl: string;
  commExclDetail: string;
  /** Deeds currently awaiting tenant signature, and how many aged past 7 days. */
  awaiting: number;
  awaitingAged: number;
  /** Deeds issued with no resolvable claim contact (undeliverable to the agent). */
  deedsNoContact: number;
  /** #86 In-force guarantees expiring within 14 days (slippage tripwire). */
  lapsing14: number;
}

/** Convert a synthetic ShapeRow ([name, refs, fees, sub?]) to a LeagueRow. */
function synthEntity(key: 'branch' | 'agency' | 'referrer', rows: ShapeRow[], pRate: number, aRate: number): LeagueRow[] {
  return rows.map((r) => {
    const refs = r[1];
    const fees = r[2];
    const [sp, pd] = key === 'referrer' ? [0.78, 0.9] : convFor(key, r[0]);
    const conv = sp * pd;
    return {
      name: r[0], sub: r[3] ?? '', refs, fees,
      paid: Math.round(refs * sp), deed: Math.round(refs * conv),
      sp, conv, partnerComm: fees * pRate, agentComm: fees * aRate,
    };
  });
}

/** Build every dashboard figure for a role, period and partner scope. */
export function getDashboardData(role: Role, period: PeriodDef | Period, scope: PartnerScope): DashboardModel {
  if (liveAvailable()) return liveDashboard(role, period as Period, scope);
  return synthDashboard(role, period, scope);
}

/** Live dashboard: every figure summed from the hydrated application set. */
function liveDashboard(role: Role, period: Period, scope: PartnerScope): DashboardModel {
  const isRef = role === 'referrer';
  const a: LiveAgg = liveAggregate(role, scope, period);
  const vol = liveVolume(role, scope, period);
  // Descriptor percentages are the EFFECTIVE rate implied by the actual snapshotted
  // commission (gross commission / gross fees), never the partner's live rate, so
  // the "% of one month's rent" label always reconciles with the £ figure beside it
  // and never moves when a partner's live rate is later edited. Only when the period
  // has no fees at all (nothing to reconcile) do we fall back to the current headline
  // rate as an indicative label — and when even that is withheld (null: a referrer's
  // session never carries commission rates) the label is an em dash, never an
  // invented percentage.
  const live = getRatesFor(scope);
  const effRate = (net: number, excl: number, fallback: number | null): string =>
    a.feesGross ? fmtRatePct((net + excl) / a.feesGross) : fallback == null ? '—' : fmtRatePct(fallback);
  const pPct = effRate(a.partnerCommNet, a.partnerCommExcl, live.partner);
  const aPct = effRate(a.agentCommNet, a.agentCommExcl, live.agent);
  // Under an all-partners scope the £ amounts blend per-partner rates, so a single
  // "%" descriptor would not reconcile with the figure - label it per-partner.
  const blended = !isRef && scope === ALL_PARTNERS;

  return {
    sub: isRef
      ? 'Your referrals from sent through to deed issued, computed from your live records.'
      : 'Live view of referrals from sent through to deed issued, computed from live records.',
    funnelScope: isRef ? 'Sent to Paid to Deed Issued · your referrals' : 'Sent to Paid to Deed Issued · all branches',
    sent: a.sent.toLocaleString('en-GB'),
    paid: a.paid.toLocaleString('en-GB'),
    deed: a.deed.toLocaleString('en-GB'),
    sp: pct(a.paid, a.sent),
    pd: pct(a.deed, a.paid),
    overall: pct(a.deed, a.sent),
    guaranteed: fmtBig(a.guaranteed),
    deedcount: a.deed.toLocaleString('en-GB'),
    fees: fmtMoney(a.feesGross),
    // Commission is Management/opndoor-admin only. A referrer is never shown a
    // commission figure (#79 League, #109 exports; the Dashboard's commission card
    // is RoleOnly superadmin/management) and their session does not even carry the
    // rates, so these four read as WITHHELD rather than being computed from a
    // withheld rate. A referrer's own card shows referral performance instead.
    commTag: isRef
      ? 'Commission is not shown to referrers'
      : blended ? `Partner commission · per-partner rates, net of refunds` : `Partner · ${pPct} of one month's rent, net of refunds`,
    commHeadline: isRef ? '—' : fmtMoney(a.partnerCommNet),
    commSecondLbl: isRef
      ? ''
      : blended ? 'Agent commission (per-partner rates, net of refunds)' : `Agent commission (${aPct} of one month's rent, net)`,
    commSecondVal: isRef ? '—' : fmtMoney(a.agentCommNet),
    rent: fmtMoney(a.avgRent),
    stuckSent: a.stuckSent.toLocaleString('en-GB'),
    stuckPaid: a.stuckPaid.toLocaleString('en-GB'),
    avgSentToPaid: days(a.avgSentToPaidDays),
    avgPaidToDeed: days(a.avgPaidToDeedDays),
    branchScope: isRef ? 'your branches' : 'top branches',
    agencyScope: isRef ? 'your agency' : 'by agency',
    referrerTitle: isRef ? 'Your monthly volume' : 'Volume by referrer',
    referrerScope: isRef ? 'recent months' : 'top performers',
    branches: vol.branches,
    agencies: vol.agencies,
    referrers: vol.referrers,
    live: true,
    feesGross: fmtMoney(a.feesGross),
    refunds: signedNeg(a.refundValue),
    refundCount: a.refundCount,
    net: fmtMoney(a.feesNet),
    commExcl: signedNeg(a.partnerCommExcl + a.agentCommExcl),
    commExclDetail: `Partner ${fmtMoney(a.partnerCommExcl)} · Agent ${fmtMoney(a.agentCommExcl)}`,
    awaiting: a.awaiting,
    awaitingAged: a.awaitingAged,
    deedsNoContact: deedsWithoutContact(role, scope),
    lapsing14: lapsingWithin14(role, scope),
  };
}

/** Synthetic dashboard (mock/test mode): the deterministic parametric model. */
function synthDashboard(role: Role, period: PeriodDef | Period, scope: PartnerScope): DashboardModel {
  const isRef = role === 'referrer';
  const w = isRef ? 1 : weightFor(scope);
  const sent = isRef ? Math.max(1, Math.round(period.fSent * REF_FRACTION)) : Math.round(period.fSent * w);
  const paid = Math.round(sent * period.sp);
  const deed = Math.round(paid * period.pd);
  const feesNum = paid * AVG_RENT;
  const shape = isRef ? SHAPE_REF : SHAPE_FULL;
  const baseSent = isRef ? BASE_SENT_REF : BASE_SENT_FULL;
  const basePaid = isRef ? BASE_PAID_REF : BASE_PAID_FULL;
  const kc = sent / baseSent;
  const kf = paid / basePaid;
  const baseStuck = isRef ? [8, 3] : [74, 27];
  const rates = getRatesFor(scope);
  // Same rule as the live path: a withheld rate has no percentage to show.
  const pRate = rates.partner ?? 0;
  const aRate = rates.agent ?? 0;
  const pPct = rates.partner == null ? '—' : fmtRatePct(rates.partner);
  const aPct = rates.agent == null ? '—' : fmtRatePct(rates.agent);

  return {
    sub: isRef
      ? 'Your referrals from sent through to deed issued, across every agency and branch you refer to.'
      : 'Live view of referrals from sent through to deed issued across all agencies and branches.',
    funnelScope: isRef ? 'Sent to Paid to Deed Issued · your referrals' : 'Sent to Paid to Deed Issued · all branches',
    sent: sent.toLocaleString('en-GB'),
    paid: paid.toLocaleString('en-GB'),
    deed: deed.toLocaleString('en-GB'),
    sp: pct(paid, sent),
    pd: pct(deed, paid),
    overall: pct(deed, sent),
    guaranteed: fmtBig(deed * ANNUAL),
    deedcount: deed.toLocaleString('en-GB'),
    fees: fmtMoney(feesNum),
    // Commission is never shown to a referrer (see the live path above).
    commTag: isRef ? 'Commission is not shown to referrers' : `Partner · ${pPct} of one month's rent`,
    commHeadline: isRef ? '—' : fmtMoney(feesNum * pRate),
    commSecondLbl: isRef ? '' : `Agent commission (${aPct} of one month's rent)`,
    commSecondVal: isRef ? '—' : fmtMoney(feesNum * aRate),
    rent: '£2,180',
    stuckSent: Math.round(baseStuck[0] * kc).toString(),
    stuckPaid: Math.round(baseStuck[1] * kc).toString(),
    avgSentToPaid: '4.2',
    avgPaidToDeed: '1.8',
    branchScope: isRef ? 'your branches' : 'top branches',
    agencyScope: isRef ? 'your agency' : 'by agency',
    referrerTitle: isRef ? 'Your monthly volume' : 'Volume by referrer',
    referrerScope: isRef ? 'recent months' : 'top performers',
    branches: synthEntity('branch', scaleRows(shape.branches, kc, kf), pRate, aRate),
    agencies: synthEntity('agency', scaleRows(shape.agencies, kc, kf), pRate, aRate),
    referrers: synthEntity('referrer', scaleRows(shape.referrers, kc, kf), pRate, aRate),
    live: false,
    feesGross: fmtMoney(feesNum),
    refunds: signedNeg(0),
    refundCount: 0,
    net: fmtMoney(feesNum),
    commExcl: signedNeg(0),
    commExclDetail: '',
    awaiting: 0,
    awaitingAged: 0,
    deedsNoContact: 0,
    lapsing14: 0,
  };
}

export type TrendView = 'month' | 'branch' | 'agency' | 'referrer';
export type TrendMeasure = 'commission' | 'value' | 'count';

/**
 * The 12-month trend rows for a breakdown, carrying real net commission so the
 * commission measure reconciles with the KPIs/League/exports. Live in Supabase
 * mode; the synthetic model (single scope rate) otherwise.
 */
export function getTrend(view: TrendView, role: Role, scope: PartnerScope): TrendRow[] {
  if (liveAvailable()) return liveTrend(view, role, scope);
  // The commission measure is Management/admin only (the trend card is RoleOnly),
  // so a withheld rate contributes nothing rather than a substituted default.
  const rate = getRatesFor(scope).partner ?? 0;
  if (view === 'month') {
    return TREND_MONTHS.map((m) => { const fees = Math.round(m[1] * AVG_RENT * 0.8); return { label: m[0], count: m[1], fees, comm: Math.round(fees * rate) }; });
  }
  const key = view === 'branch' ? 'branches' : view === 'agency' ? 'agencies' : 'referrers';
  return scaleRows(SHAPE_FULL[key], 3.754, 3.832).map((r) => ({ label: r[0], count: r[1], fees: r[2], comm: Math.round(r[2] * rate), sub: r[3] }));
}
