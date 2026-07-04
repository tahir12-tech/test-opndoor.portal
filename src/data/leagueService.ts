/* =====================================================================
   League service — the full ranked datasets behind the dashboard
   breakdowns (the dashboard shows the top ten; the League page shows all).
   Agencies and branches are real org records; referrers are synthesised.
   Respects role + partner scoping and uses per-partner commission rates.

   INTEGRATION: getLeague -> GET a period/partner-scoped ranking endpoint.
   The page sorts, searches and pages client-side today; a real back end
   could accept sort/search/page params and paginate server-side.
   ===================================================================== */
import type { LeagueRow, LeagueView, PartnerScope, Period, Role } from './types';
import { ALL_PARTNERS } from './types';
import { liveAvailable, liveLeague } from './liveAnalytics';
import { getAgencies } from './orgService';
import { getRatesFor, homePartner, partnerName } from './partnersService';
import { AVG_RENT, LEAGUE_REFERRER_NAMES, convFor } from './mock/analyticsModel';
import type { Agency, Branch } from './types';
import { HOME_PARTNER } from './mock/partners';

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
