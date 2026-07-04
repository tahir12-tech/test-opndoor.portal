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
          rows.push({ name: a.name, sub, partner: partnerName(a.partner || HOME_PARTNER), refs, fees, paid: Math.round(refs * sp), deed: Math.round(refs * cv), sp, conv: cv, partnerComm: 0, agentComm: 0 });
        } else {
          (a.branches || []).forEach((b) => {
            const refs = b.referrals || 0;
            const fees = feesOf(b);
            const [sp, pd] = convFor('branch', b.name);
            const cv = sp * pd;
            rows.push({ name: b.name, sub: `${a.name} · ${b.area || ''}`, partner: partnerName(a.partner || HOME_PARTNER), refs, fees, paid: Math.round(refs * sp), deed: Math.round(refs * cv), sp, conv: cv, partnerComm: 0, agentComm: 0 });
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
      rows.push({ name: nm, sub: 'Referrer', refs, fees: Math.round(refs * 0.8 * AVG_RENT), paid: Math.round(refs * sp), deed: Math.round(refs * cv), sp, conv: cv, partnerComm: 0, agentComm: 0 });
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
    const { data, error } = await sb().rpc('referrer_league', { p_start: start.toISOString(), p_end: end.toISOString() });
    if (error) throw new Error(error.message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: ReferrerLeagueRow[] = (data ?? []).map((r: any) => ({
      name: r.name ?? '(unknown)', refs: Number(r.refs) || 0, fees: Number(r.fees) || 0, self: !!r.is_self,
    }));
    return { mode, rows };
  }
  // Mock: the signed-in referrer is the first name (Priya Nair).
  const SELF = LEAGUE_REFERRER_NAMES[0];
  const all: ReferrerLeagueRow[] = LEAGUE_REFERRER_NAMES
    .map((nm, i) => {
      const refs = Math.max(3, Math.round(40 - i * 1.6));
      return { name: nm, refs, fees: Math.round(refs * 0.8 * AVG_RENT), self: nm === SELF };
    })
    .sort((a, b) => b.refs - a.refs);
  // #87 The viewing referrer's own row must always be present (even at zero).
  if (!all.some((r) => r.self)) all.push({ name: SELF, refs: 0, fees: 0, self: true });
  if (mode === 'private') return { mode, rows: all.filter((r) => r.self) };
  if (mode === 'rankings') return { mode, rows: all.map((r) => ({ ...r, fees: 0 })) };
  return { mode, rows: all };
}
