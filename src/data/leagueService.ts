/* =====================================================================
   League service — the full ranked datasets behind the dashboard
   breakdowns (the dashboard shows the top ten; the League page shows all).
   Agencies and branches are real org records; referrers are synthesised.
   Respects role + partner scoping and uses per-partner commission rates.

   INTEGRATION: getLeague -> GET a period/partner-scoped ranking endpoint.
   The page sorts, searches and pages client-side today; a real back end
   could accept sort/search/page params and paginate server-side.
   ===================================================================== */
import type { LeaderboardMode, LeagueRow, LeagueView, PartnerScope, Period, Role } from './types';
import { ALL_PARTNERS } from './types';
import { liveAvailable, liveLeague } from './liveAnalytics';
import { periodRange } from './paymentMetrics';
import { getAgencies } from './orgService';
import { getRatesFor, getReferrerLeaderboardMode, homePartner, partnerName } from './partnersService';
import { AVG_RENT, LEAGUE_REFERRER_NAMES, convFor } from './mock/analyticsModel';
import type { Agency, Branch } from './types';
import { HOME_PARTNER } from './mock/partners';
import { sb } from '@/lib/supabase';

const DAY = 86_400_000;

// #107 Deterministic mock movement so the demo League shows ▲/▼/– without a live
// back end. Keyed on the entity name so it is stable across renders.
const MOCK_MOVE = [2, 0, -1, 1, 0, -2, 3, 0, -1, 1];
const mockMove = (key: string): number => MOCK_MOVE[key.length % MOCK_MOVE.length];

export interface LeagueOpts {
  role: Role;
  scope: PartnerScope;
  /** opndoor admin's in-page partner filter (empty = all). */
  partner?: string;
  /** The dashboard period, driving the live date range (ignored in mock mode). */
  period?: Period;
}

function feesOf(rec: Agency | Branch): number {
  if (rec.fees) return rec.fees;
  return Math.round((rec.referrals || 0) * 0.78 * AVG_RENT);
}

export function getLeague(view: LeagueView, opts: LeagueOpts): LeagueRow[] {
  const { role, scope } = opts;
  const partner = opts.partner || '';
  // Live mode: every tab (incl. referrers) computed from live records, period-scoped.
  if (liveAvailable() && opts.period) return liveLeague(view, role, scope, partner, opts.period);
  const rates = getRatesFor(scope === ALL_PARTNERS ? partner || ALL_PARTNERS : scope);

  const inScope = (a: Agency): boolean => {
    const p = a.partner || HOME_PARTNER;
    if (role !== 'superadmin') return p === homePartner();
    if (scope !== ALL_PARTNERS) return p === scope;
    if (partner) return p === partner;
    return true;
  };

  const rows: LeagueRow[] = [];

  if (view === 'agency' || view === 'branch') {
    getAgencies(ALL_PARTNERS)
      .filter(inScope)
      .forEach((a) => {
        if (view === 'agency') {
          const refs = a.referrals || 0;
          const fees = feesOf(a);
          const [sp, pd] = convFor('agency', a.name);
          const cv = sp * pd;
          const sub = `${a.branches ? a.branches.length : 0} branches`;
          rows.push({ name: a.name, sub, partner: partnerName(a.partner || HOME_PARTNER), refs, fees, paid: Math.round(refs * sp), deed: Math.round(refs * cv), sp, conv: cv, partnerComm: 0, agentComm: 0, movement: mockMove(a.name) });
        } else {
          (a.branches || []).forEach((b) => {
            const refs = b.referrals || 0;
            const fees = feesOf(b);
            const [sp, pd] = convFor('branch', b.name);
            const cv = sp * pd;
            rows.push({ name: b.name, sub: `${a.name} · ${b.area || ''}`, partner: partnerName(a.partner || HOME_PARTNER), refs, fees, paid: Math.round(refs * sp), deed: Math.round(refs * cv), sp, conv: cv, partnerComm: 0, agentComm: 0, movement: mockMove(b.name) });
          });
        }
      });
  } else {
    // Referrers: synthesise a plausible league from names, scaled by scope.
    const seedBase = scope === ALL_PARTNERS && !partner ? 1 : 0.4;
    LEAGUE_REFERRER_NAMES.forEach((nm, i) => {
      const refs = Math.max(3, Math.round((40 - i * 1.6) * seedBase));
      const sp = 0.72 + ((i * 5) % 16) / 100;
      const pd = 0.86 + ((i * 3) % 10) / 100;
      const cv = sp * pd;
      rows.push({ name: nm, sub: 'Referrer', refs, fees: Math.round(refs * 0.8 * AVG_RENT), paid: Math.round(refs * sp), deed: Math.round(refs * cv), sp, conv: cv, partnerComm: 0, agentComm: 0, movement: MOCK_MOVE[i % MOCK_MOVE.length] });
    });
  }

  rows.forEach((r) => {
    r.partnerComm = r.fees * rates.partner;
    r.agentComm = r.fees * rates.agent;
  });
  return rows;
}

// ---- #79 Referrer leaderboard (referrers only) ----
export interface ReferrerLeagueRow {
  name: string;
  refs: number;
  /** Fees collected. Only populated in 'full' mode; 0 otherwise. Never commission. */
  fees: number;
  /** True for the signed-in referrer's own row. */
  self: boolean;
  /** #5 Week-over-week rank movement vs the same table 7 days prior: positive =
      climbed N places, negative = fell, 0 = held, null = new / not comparable. */
  movement: number | null;
}
export interface ReferrerBoard {
  mode: LeaderboardMode;
  rows: ReferrerLeagueRow[];
}

/**
 * The referrer's own-partner leaderboard: positions and referral counts, plus
 * fees collected only in 'full' mode. Commission is never included. A referrer's
 * RLS scope hides sibling referrers, so live mode reads the SECURITY DEFINER
 * referrer_league RPC (which also enforces the mode server-side). Mock mode
 * synthesises the partner's referrers with the signed-in user (Priya Nair) as
 * self, honouring the same mode.
 */
export async function getReferrerLeague(period: Period): Promise<ReferrerBoard> {
  const mode = getReferrerLeaderboardMode(homePartner());
  if (liveAvailable()) {
    const [start, end] = periodRange(period);
    // #5 Movement = rank change vs the SAME table 7 days earlier: run the ranking
    // again with the window end pulled back a week (on-the-fly, no snapshot store).
    const prevEnd = new Date(end.getTime() - 7 * DAY);
    const [cur, prev] = await Promise.all([
      sb().rpc('referrer_league', { p_start: start.toISOString(), p_end: end.toISOString() }),
      prevEnd > start
        ? sb().rpc('referrer_league', { p_start: start.toISOString(), p_end: prevEnd.toISOString() })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (cur.error) throw new Error(cur.error.message);
    // Prior-rank by name (rows arrive already ranked, so index === rank).
    const priorRank = new Map<string, number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prev.data ?? []).forEach((r: any, i: number) => priorRank.set(r.name ?? '', i));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: ReferrerLeagueRow[] = (cur.data ?? []).map((r: any, i: number) => {
      const nm = r.name ?? '(unknown)';
      const pr = priorRank.get(nm);
      return { name: nm, refs: Number(r.refs) || 0, fees: Number(r.fees) || 0, self: !!r.is_self, movement: pr == null ? null : pr - i };
    });
    return { mode, rows };
  }
  // Mock: the signed-in referrer is the first name (Priya Nair).
  const SELF = LEAGUE_REFERRER_NAMES[0];
  // #5 Deterministic mock movement so the demo shows ▲/▼/– without a live back end.
  const MOCK_MOVE = [1, 0, -1, 2, 0, -2, 1, 0];
  const all: ReferrerLeagueRow[] = LEAGUE_REFERRER_NAMES
    .map((nm, i) => {
      const refs = Math.max(3, Math.round(40 - i * 1.6));
      return { name: nm, refs, fees: Math.round(refs * 0.8 * AVG_RENT), self: nm === SELF, movement: MOCK_MOVE[i % MOCK_MOVE.length] };
    })
    // #104 Rank by fees collected primary, referral count secondary, name tiebreak
    // (matches the referrer_league RPC). Sorting only by count let a £0 referrer
    // outrank a paying one.
    .sort((a, b) => b.fees - a.fees || b.refs - a.refs || a.name.localeCompare(b.name));
  // #87 The viewing referrer's own row must always be present (even at zero).
  if (!all.some((r) => r.self)) all.push({ name: SELF, refs: 0, fees: 0, self: true, movement: null });
  if (mode === 'private') return { mode, rows: all.filter((r) => r.self) };
  if (mode === 'rankings') return { mode, rows: all.map((r) => ({ ...r, fees: 0 })) };
  return { mode, rows: all };
}
