/* =====================================================================
   Dashboard — the analytics home. Funnel, hero KPIs, commission (role-gated,
   per-partner rates), the three volume charts with measure dropdowns, the
   12-month trend (Management + opndoor admin), the support metrics, the
   period + partner filters, and the three CSV exports incl. the bordereau.

   Every figure comes from analyticsService/exportsService (the parametric
   model). INTEGRATION points live in those services, not here.
   ===================================================================== */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ALL_PARTNERS, buildApplicationDoc, buildBordereauCsv, buildExpiriesCsv, buildPerformanceDoc, downloadCsv, exportBranded,
  fmtBig, getCommissionSettlement, getAgentCommissionSettlement, livePartnerBreakdown, getDashboardData, getPartners, getPeriods, getTrend, partnerName,
  getBordereauRate, getBordereauRateMeta, setBordereauRate, pendingTenancyCorrections,
  type LeagueRow, type Period, type TrendRow,
} from '@/data';
import { BASIS_META, type ExportBasis } from '@/data';
import { useSession } from '@/session/SessionContext';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Card, CardBody, CardFoot, CardHead } from '@/components/ui/Card';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Pill } from '@/components/ui/Pill';
import { Tag } from '@/components/ui/Tag';
import { RoleOnly } from '@/components/ui/RoleOnly';
import { RoleNote } from '@/components/ui/RoleNote';
import { BarChart, type BarRow } from '@/components/ui/BarChart';
import { MeasureSelect, PeriodSelect, TrendSelect } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import './Dashboard.css';

type ChartKey = 'branch' | 'agency' | 'referrer';
type Measure = 'value' | 'count' | 'conv';
type TrendMeasure = 'commission' | 'value' | 'count';
type TrendView = 'month' | 'branch' | 'agency' | 'referrer';

const TOP_N = 10;

function measureLabel(m: string): string {
  return m === 'commission' ? 'Commission earned' : m === 'conv' ? 'Conversion, Sent to Deed' : m === 'value' ? 'Fees collected' : 'Referrals sent';
}

/**
 * Build the (top-10) bars for a volume chart: fees / count / conversion, with an
 * always-on Sent-to-Deed sub-line on branch and agency bars (and the parent
 * agency on branch bars). Returns the bars, the total for the count line, and a
 * fixed max for the conversion measure (scaled against 100%).
 */
function buildChartRows(key: ChartKey, rows: LeagueRow[], m: Measure): { bars: BarRow[]; total: number; max?: number } {
  const showConv = key === 'branch' || key === 'agency';
  const isConv = m === 'conv' && showConv;
  const total = rows.length;

  if (isConv) {
    const sorted = rows
      .map((r) => ({ label: r.name, sub: r.sub || undefined, pct: Math.round(r.conv * 100) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, TOP_N);
    return { bars: sorted.map((x) => ({ label: x.label, sub: x.sub, value: x.pct, display: `${x.pct}%` })), total, max: 100 };
  }

  const sorted = rows.slice().sort((a, b) => (m === 'value' ? b.fees - a.fees : b.refs - a.refs)).slice(0, TOP_N);
  const bars: BarRow[] = sorted.map((r) => {
    const subBits: string[] = [];
    if (r.sub) subBits.push(r.sub);
    if (showConv) subBits.push(`${Math.round(r.conv * 100)}% Sent to Deed`);
    return { label: r.name, sub: subBits.join(' · ') || undefined, value: m === 'value' ? r.fees : r.refs, display: m === 'value' ? fmtBig(r.fees) : String(r.refs) };
  });
  return { bars, total };
}

export function Dashboard() {
  usePageMeta('dashboard', 'Dashboard', ['Home', 'Dashboard']);
  const { role, partnerScope, selectedPartner, setSelectedPartner, period, setPeriod } = useSession();
  const toast = useToast();

  // Every figure comes from getDashboardData: live records in Supabase mode
  // (d.live), the deterministic synthetic model in mock/test mode.
  const d = useMemo(() => getDashboardData(role, period, partnerScope), [role, period, partnerScope]);
  // Partner commission settlement for the prior calendar month (payment-date
  // accrual, net of refunds), payable on the 15th. Live mode only; ignores the
  // period filter (it is a fixed monthly settlement question).
  const settlement = useMemo(() => getCommissionSettlement(role, partnerScope), [role, partnerScope]);
  // Agent commission settlement (agency level) and the per-partner commission
  // breakdown for the selected period. Live mode, non-referrers.
  const agentSettlement = useMemo(() => getAgentCommissionSettlement(role, partnerScope), [role, partnerScope]);
  const partnerBreakdown = useMemo(() => livePartnerBreakdown(role, partnerScope, period), [role, partnerScope, period]);
  // Settlement is a money-reconciliation surface: show pence on every row and the
  // total so the rows always sum to the stated total (commission is rent x rate,
  // which is frequently a half-pound).
  const gbpPence = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const settleDate = `${settlement.settlementDate.getDate()} ${settlement.settlementDate.toLocaleDateString('en-GB', { month: 'long' })} ${settlement.settlementDate.getFullYear()}`;
  const agentSettleDate = `${agentSettlement.settlementDate.getDate()} ${agentSettlement.settlementDate.toLocaleDateString('en-GB', { month: 'long' })} ${agentSettlement.settlementDate.getFullYear()}`;
  const dmyShort = (x: Date) => `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;

  // ---- Needs-attention row (compact stat-lines promoted from existing data) ----
  // Same scoped figures shown everywhere; each line renders only when non-zero.
  const canSeeSettlements = role === 'superadmin' || role === 'management';
  const partnerDue = settlement.partners.reduce((s, p) => s + p.commission, 0);
  const agentDue = agentSettlement.agencies.reduce((s, a) => s + a.commission, 0);
  const settleDayMonth = `${settlement.settlementDate.getDate()} ${settlement.settlementDate.toLocaleDateString('en-GB', { month: 'long' })}`;
  // #81 Agent-reported tenancy-start corrections awaiting opndoor review.
  const [corrections, setCorrections] = useState(0);
  useEffect(() => {
    if (role === 'referrer') { setCorrections(0); return; }
    let alive = true;
    pendingTenancyCorrections().then((n) => { if (alive) setCorrections(n); }).catch(() => { if (alive) setCorrections(0); });
    return () => { alive = false; };
  }, [role]);

  const naAwaiting = d.live && d.awaiting > 0;
  const naStuckSent = d.stuckSent !== '0';
  const naSettlements = d.live && canSeeSettlements && (partnerDue > 0 || agentDue > 0);
  const naNoContact = d.live && d.deedsNoContact > 0;
  const naCorrections = canSeeSettlements && corrections > 0;
  const naLapsing = d.live && canSeeSettlements && d.lapsing14 > 0;
  const hasNeedsAttention = naAwaiting || naStuckSent || naSettlements || naNoContact || naCorrections || naLapsing;

  // #25: the agent settlement can span many agencies, so show the top 5 inline and
  // collapse the rest behind a "View all" expander. The Performance export always
  // carries the full list. (The partner settlement is a bounded set and stays full.)
  const agentTop = agentSettlement.agencies.slice(0, 5);
  const agentRest = agentSettlement.agencies.slice(5);
  const agentAgencyRow = (a: (typeof agentSettlement.agencies)[number]) => (
    <div key={`${a.partner}-${a.agency}`} className="settle__partner">
      <div className="settle__row">
        <span>Agent commission payable to <b>{a.agency}</b></span>
        <span className="settle__amt">{gbpPence(a.commission)}</span>
      </div>
      <details className="settle__exp">
        <summary>Show applications ({a.apps.length})</summary>
        <div className="settle__apps">
          <table>
            <thead>
              <tr><th>Reference</th><th>Branch</th><th className="num">Paid</th><th className="num">Fee</th><th className="num">Agent commission</th></tr>
            </thead>
            <tbody>
              {a.apps.map((ap) => (
                <tr key={ap.ref}>
                  <td>{ap.ref}</td>
                  <td>{ap.branch}</td>
                  <td className="num">{dmyShort(ap.paidAt)}</td>
                  <td className="num">{gbpPence(ap.rent)}</td>
                  <td className="num">{gbpPence(ap.commission)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );

  const [measure, setMeasure] = useState<Record<ChartKey, Measure>>({ branch: 'value', agency: 'value', referrer: 'value' });
  const [trendView, setTrendView] = useState<TrendView>('month');
  const [trendMeasure, setTrendMeasure] = useState<TrendMeasure>('commission');

  const partners = getPartners();
  const periods = getPeriods();

  // The scope label shows only for opndoor admin; Management only ever sees its own partner.
  const scopeName = partnerScope === ALL_PARTNERS ? 'All partners' : partnerName(partnerScope);
  const eyebrowText = `${role === 'superadmin' ? `${scopeName} · ` : ''}Performance · ${period.label}`;

  // ---- volume charts ----
  const chartMeta: { key: ChartKey; rows: LeagueRow[]; scope: string }[] = [
    { key: 'branch', rows: d.branches, scope: d.branchScope },
    { key: 'agency', rows: d.agencies, scope: d.agencyScope },
    { key: 'referrer', rows: d.referrers, scope: d.referrerScope },
  ];

  // ---- monthly trend ----
  const trendVal = (r: TrendRow): number => (trendMeasure === 'count' ? r.count : trendMeasure === 'commission' ? r.comm : r.fees);
  const rawTrend = getTrend(trendView, role, partnerScope);
  const trendRows: BarRow[] = useMemo(() => {
    const rows = rawTrend.slice();
    // "By month" keeps chronological order (latest highlighted); breakdowns sort by value.
    if (trendView !== 'month') rows.sort((a, b) => trendVal(b) - trendVal(a));
    return rows.map((r) => ({ label: r.label, sub: r.sub, value: trendVal(r), display: trendMeasure === 'count' ? String(r.count) : fmtBig(trendVal(r)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTrend, trendView, trendMeasure]);
  const trendTopIndex = trendView === 'month' ? trendRows.length - 1 : 0;
  // Entity views (branch/agency/referrer) are 12-month TOTALS, not a monthly
  // series, so the caption states that explicitly (the bars have no time axis by design).
  const trendSub = `${measureLabel(trendMeasure)} · ${trendView === 'month' ? 'last 12 months' : `by ${trendView} · total over the last 12 months`}`;

  // ---- exports ----
  const [bdxOpen, setBdxOpen] = useState(false);
  const [bdxMonth, setBdxMonth] = useState('2026-06');
  const [bdxRate, setBdxRate] = useState(String(getBordereauRate()));
  const [bdxBusy, setBdxBusy] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [appsBasis, setAppsBasis] = useState<ExportBasis>('referred');
  // #86 Expiries export, defaulting to the month ~6 weeks out (the cron cohort).
  const [expOpen, setExpOpen] = useState(false);
  const [expMonth, setExpMonth] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 42); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });

  function exportSummary() {
    void exportBranded(buildPerformanceDoc(role, period as Period));
  }
  function runAppsExport() {
    const built = buildApplicationDoc(role, period as Period, appsBasis);
    if (built) void exportBranded(built);
    setAppsOpen(false);
  }
  function openBordereau() {
    // Default to the stored rate (not a hard-coded value), so it no longer reverts.
    setBdxRate(String(getBordereauRate()));
    setBdxOpen(true);
  }
  function runExpiries() {
    const mv = (expMonth || '2026-06').split('-');
    const out = buildExpiriesCsv(role, +mv[0], +mv[1] - 1);
    if (out) downloadCsv(out.csv, out.filename);
    setExpOpen(false);
  }
  async function exportBordereau() {
    if (bdxBusy) return;
    const mv = (bdxMonth || '2026-06').split('-');
    const parsed = parseFloat(bdxRate);
    const rate = isNaN(parsed) ? getBordereauRate() : parsed;
    setBdxBusy(true);
    try {
      // Persist the applied rate (audited if it changed) so the next export defaults
      // to it and there is a record of what was applied when, and by whom.
      await setBordereauRate(rate);
      const out = buildBordereauCsv(role, +mv[0], +mv[1] - 1, rate);
      if (out) downloadCsv(out.csv, out.filename);
      setBdxOpen(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the insurance rate.');
    } finally {
      setBdxBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <Eyebrow>{eyebrowText}</Eyebrow>
          <h1 className="page-head__title" style={{ marginTop: 10 }}>Dashboard</h1>
          <p className="page-head__sub">{d.sub}</p>
        </div>
        <div className="page-head__actions">
          <RoleOnly roles={['superadmin']}>
            <PeriodSelect
              ariaLabel="Partner"
              title="View all partners combined, or drill into one partner"
              value={selectedPartner}
              onChange={setSelectedPartner}
              options={[{ value: ALL_PARTNERS, label: 'All partners' }, ...partners.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </RoleOnly>
          <PeriodSelect ariaLabel="Dashboard time period" value={period.id} onChange={setPeriod} options={periods.map((p) => ({ value: p.id, label: p.label }))} />
          <Button variant="dark" size="sm" onClick={exportSummary} title="Downloads a structured CSV of the dashboard analytics for the selected time period">
            <Icon name="download" /> Export summary
          </Button>
          <RoleOnly roles={['superadmin', 'management']}>
            <Button variant="ghost" size="sm" onClick={() => setAppsOpen(true)} title="Downloads one row per application, pseudonymised by guarantee reference">
              <Icon name="apps" /> Application export
            </Button>
          </RoleOnly>
          <RoleOnly roles={['superadmin', 'management']}>
            <Button variant="ghost" size="sm" onClick={() => setExpOpen(true)} title="Guarantees expiring in a chosen month, soonest first, for renewal outreach">
              <Icon name="calendar" /> Expiries
            </Button>
          </RoleOnly>
          <RoleOnly roles={['superadmin']}>
            <Button variant="primary" size="sm" onClick={openBordereau} title="Monthly underwriter bordereau (C&C format) with full tenant details. opndoor admin only.">
              <Icon name="shield" /> Bordereau
            </Button>
          </RoleOnly>
        </div>
      </div>

      <RoleOnly roles={['referrer']}>
        <RoleNote style={{ marginBottom: 18 }}>
          You are viewing your <b>own referrals only</b>. Management and super-admin users see the full portfolio across every agency and branch.
        </RoleNote>
      </RoleOnly>

      <div className="dash-grid">
        {/* NEEDS ATTENTION — compact stat-lines, each linking to the relevant view */}
        {hasNeedsAttention && (
          <section className="needs-attn">
            {naAwaiting && (
              <Link className="na-stat na-stat--sign" to="/applications?deed=awaiting" title="Applications with a deed out for the tenant's signature">
                <span className="na-stat__n">{d.awaiting}</span>
                <span className="na-stat__l">awaiting tenant signature</span>
                <Icon name="arrowRight" className="na-stat__go" />
              </Link>
            )}
            {naStuckSent && (
              <Link className="na-stat na-stat--sent" to="/applications?status=sent" title="Applications sent but not yet paid">
                <span className="na-stat__n">{d.stuckSent}</span>
                <span className="na-stat__l">stuck at Sent · awaiting payment</span>
                <Icon name="arrowRight" className="na-stat__go" />
              </Link>
            )}
            {naNoContact && (
              <Link className="na-stat na-stat--warn" to="/applications?deed=delivery-failed" title="Deeds issued but not delivered to the agent (no reachable claim contact). Open the list to add a contact, then resend the deed.">
                <span className="na-stat__n">{d.deedsNoContact}</span>
                <span className="na-stat__l">deed{d.deedsNoContact === 1 ? '' : 's'} issued · delivery failed, view and resend</span>
                <Icon name="arrowRight" className="na-stat__go" />
              </Link>
            )}
            {naCorrections && (
              <Link className="na-stat na-stat--warn" to="/activity" title="An agent reported that a deed's tenancy start date is incorrect. Review in the activity feed and amend the application if correct.">
                <span className="na-stat__n">{corrections}</span>
                <span className="na-stat__l">tenancy-start correction{corrections === 1 ? '' : 's'} reported by agents, review</span>
                <Icon name="arrowRight" className="na-stat__go" />
              </Link>
            )}
            {naLapsing && (
              <Link className="na-stat na-stat--warn" to="/activity" title="In-force guarantees expiring within 14 days. Arrange a renewal or a fresh referral so cover stays in place.">
                <span className="na-stat__n">{d.lapsing14}</span>
                <span className="na-stat__l">guarantee{d.lapsing14 === 1 ? '' : 's'} lapsing within 14 days</span>
                <Icon name="arrowRight" className="na-stat__go" />
              </Link>
            )}
            {naSettlements && (
              <a className="na-stat na-stat--pay" href="#settlements" title="Jump to the settlement sections below">
                <span className="na-stat__l">
                  <b>Settlements due {settleDayMonth}:</b> {gbpPence(partnerDue)} partner / {gbpPence(agentDue)} agent
                </span>
                <Icon name="arrowRight" className="na-stat__go" />
              </a>
            )}
          </section>
        )}

        {/* FUNNEL */}
        <Card>
          <CardHead
            title="Live referral funnel"
            sub={d.funnelScope}
            actions={<Pill variant="paid" style={{ fontSize: 12 }}>Sent to Paid is the headline metric</Pill>}
          />
          <CardBody>
            <div className="funnel">
              <div className="fstage fstage--sent">
                <div className="fstage__top"><Pill variant="sent">Sent</Pill></div>
                <div className="fstage__count">{d.sent}</div>
                <div className="fstage__label">Referrals sent to tenants</div>
                <div className="fstage__bar"><i /></div>
              </div>
              <div className="fconnect fconnect--head">
                <div className="fconnect__cap">Sent → Paid</div>
                <div className="fconnect__rate">{d.sp}</div>
                <div className="fconnect__arrow"><Icon name="arrowRight" /></div>
              </div>
              <div className="fstage fstage--paid">
                <div className="fstage__top"><Pill variant="paid">Paid</Pill></div>
                <div className="fstage__count">{d.paid}</div>
                <div className="fstage__label">Guarantor fee paid</div>
                <div className="fstage__bar"><i /></div>
              </div>
              <div className="fconnect">
                <div className="fconnect__cap">Paid → Deed</div>
                <div className="fconnect__rate">{d.pd}</div>
                <div className="fconnect__arrow"><Icon name="arrowRight" /></div>
              </div>
              <div className="fstage fstage--deed">
                <div className="fstage__top"><Pill variant="deed">Deed Issued</Pill></div>
                <div className="fstage__count">{d.deed}</div>
                <div className="fstage__label">Guarantee deeds issued</div>
                <div className="fstage__bar"><i /></div>
              </div>
            </div>
            {d.live && (
              <div className="funnel-note">
                <Icon name="info" strokeWidth={2} />
                <span>Conversion is <b>period throughput</b>: each stage counts the events that occurred within the period, so a rate can exceed 100% when payments or deeds land this period for referrals sent earlier.</span>
              </div>
            )}
          </CardBody>
          <CardFoot>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Overall sent to deed conversion <b style={{ color: 'var(--ink)' }}>{d.overall}</b>
              {d.live && d.awaiting > 0 && (
                <> · <b style={{ color: 'var(--sent)' }}>{d.awaiting}</b> awaiting tenant signature{d.awaitingAged > 0 ? ` (${d.awaitingAged} over 7 days)` : ''}</>
              )}
            </span>
            <Button variant="quiet" size="sm" to="/applications" arrow>View all applications</Button>
          </CardFoot>
        </Card>

        {/* HERO KPIs */}
        <section className="herorow">
          <RoleOnly roles={['superadmin', 'management']}>
            {/* #85 Net fees leads the money block; Total guaranteed rent value second. */}
            <div className="card hero-kpi hero-kpi--dark">
              <div className="kpi__label">Net fees{d.live ? ' (after refunds)' : ''}</div>
              <div className="hero-kpi__row" style={{ marginTop: 10 }}>
                <span className="hero-kpi__big">{d.live ? d.net : d.fees}</span>
              </div>
              <p style={{ position: 'relative', fontSize: 13, color: 'rgba(255,255,255,0.72)', marginTop: 8, maxWidth: '42ch' }}>
                Guarantor fees collected across {d.deedcount} issued deeds, one month's rent each, net of any refunds.
              </p>
              {d.live && (
                <div className="hero-kpi__split">
                  <div><span className="k">Fees collected (gross)</span><span className="v">{d.feesGross}</span></div>
                  <div><span className="k">Less refunds{d.refundCount ? ` (${d.refundCount})` : ''}</span><span className="v v--neg">{d.refunds}</span></div>
                </div>
              )}
              <div className="hero-kpi__sub" style={{ marginTop: 14 }}>
                <span className="lbl">Total guaranteed rent value</span>
                <span className="val">{d.guaranteed}</span>
              </div>
            </div>
          </RoleOnly>

          <RoleOnly roles={['referrer']}>
            <div className="card hero-kpi hero-kpi--dark">
              <div className="kpi__label">Your fees collected{d.live ? ' (net of refunds)' : ''}</div>
              <div className="hero-kpi__row" style={{ marginTop: 10 }}>
                <span className="hero-kpi__big">{d.live ? d.net : d.fees}</span>
              </div>
              <p style={{ position: 'relative', fontSize: 13, color: 'rgba(255,255,255,0.72)', marginTop: 8, maxWidth: '42ch' }}>
                Guarantor fees from the referrals you sent that reached Paid, at one month's rent each.
              </p>
              {d.live ? (
                <div className="hero-kpi__split">
                  <div><span className="k">Fees collected (gross)</span><span className="v">{d.feesGross}</span></div>
                  <div><span className="k">Less refunds{d.refundCount ? ` (${d.refundCount})` : ''}</span><span className="v v--neg">{d.refunds}</span></div>
                  <div><span className="k">Your referrals paid</span><span className="v">{d.paid}</span></div>
                </div>
              ) : (
                <div className="hero-kpi__sub">
                  <span className="lbl">Your referrals paid</span>
                  <span className="val">{d.paid}</span>
                </div>
              )}
            </div>
          </RoleOnly>

          <RoleOnly roles={['superadmin', 'management']}>
            <div className="card hero-kpi">
              <div className="spread">
                <div className="kpi__label">{d.live ? 'Commission earned' : 'Commission earned to date'}</div>
                <Tag>{d.commTag}</Tag>
              </div>
              <div className="hero-kpi__row" style={{ marginTop: 14 }}>
                <span className="comm-headline">{d.commHeadline}</span>
                {d.live
                  ? (d.refundCount > 0 && <span className="muted" style={{ fontSize: 12 }}>Excluded on refunds {d.commExcl}</span>)
                  : <span className="kpi__delta kpi__delta--up"><Icon name="caretUp" strokeWidth={2.4} />12.4% vs prior period</span>}
              </div>
              <div style={{ marginTop: 'auto', paddingTop: 18, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span className="muted" style={{ fontSize: 13 }}>{d.commSecondLbl}</span>
                <span style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 18, color: 'var(--ink)' }}>{d.commSecondVal}</span>
              </div>
              {d.live && d.refundCount > 0 && (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>{d.commExclDetail} excluded on refunded fees</div>
              )}
            </div>
          </RoleOnly>

          <RoleOnly roles={['referrer']}>
            <div className="card hero-kpi">
              <div className="spread">
                <div className="kpi__label">Your referral performance</div>
                <Tag>Your own slice</Tag>
              </div>
              <div className="hero-kpi__row" style={{ marginTop: 14 }}>
                <span className="comm-headline" style={{ color: 'var(--ink)' }}>{d.sent}</span>
                <span className="muted" style={{ fontSize: 14, fontWeight: 600 }}>referrals sent</span>
              </div>
              <div style={{ marginTop: 'auto', paddingTop: 18, borderTop: '1px solid var(--line)', display: 'flex', gap: 30 }}>
                <div><div className="muted" style={{ fontSize: 12 }}>Sent → Paid</div><div style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 22, letterSpacing: '-0.02em', color: 'var(--heliotrope-deep)', marginTop: 2 }}>{d.sp}</div></div>
                <div><div className="muted" style={{ fontSize: 12 }}>Paid → Deed</div><div style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 22, letterSpacing: '-0.02em', color: 'var(--ink)', marginTop: 2 }}>{d.pd}</div></div>
                <div><div className="muted" style={{ fontSize: 12 }}>Deeds issued</div><div style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 22, letterSpacing: '-0.02em', color: 'var(--ink)', marginTop: 2 }}>{d.deedcount}</div></div>
              </div>
            </div>
          </RoleOnly>
        </section>

        {/* Live payment figures (gross/refunds/net + net commission) are folded
            into the hero KPIs above; there is no separate block. */}

        {/* PERFORMANCE BAND: commission-by-partner, then the breakdown cards, then trend. */}
        {/* COMMISSION BY PARTNER (selected period) */}
        {d.live && partnerBreakdown.length > 0 && (
          <RoleOnly roles={['superadmin', 'management']}>
            <section className="card settle">
              <div className="settle__head">
                <div>
                  <div className="kpi__label">Commission by partner</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                    Partner and agent commission for the <b>selected period</b>, gross and net of refunds. Net columns reconcile to the summary totals. Settlement (what is actually payable next) is calculated separately, for the <b>prior calendar month</b>. Active partners are listed even with no paid referrals in the period; paused or onboarding partners with no activity are not shown.
                  </div>
                </div>
              </div>
              <div className="settle__apps">
                <table>
                  <thead>
                    <tr>
                      <th>Partner</th><th className="num">Paid</th><th className="num">Fees (gross)</th>
                      <th className="num">Partner comm (gross)</th><th className="num">Partner comm (net)</th>
                      <th className="num">Agent comm (gross)</th><th className="num">Agent comm (net)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {partnerBreakdown.map((p) => (
                      <tr key={p.partner}>
                        <td>{p.partnerName}</td>
                        <td className="num">{p.paid}</td>
                        <td className="num">{gbpPence(p.feesGross)}</td>
                        <td className="num">{gbpPence(p.partnerCommGross)}</td>
                        <td className="num">{gbpPence(p.partnerCommNet)}</td>
                        <td className="num">{gbpPence(p.agentCommGross)}</td>
                        <td className="num">{gbpPence(p.agentCommNet)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </RoleOnly>
        )}

        {/* CHARTS */}
        <section className="chartrow">
          {chartMeta.map(({ key, rows, scope }) => {
            const { bars, total, max } = buildChartRows(key, rows, measure[key]);
            const options = key === 'referrer'
              ? [{ value: 'value', label: 'Fees collected' }, { value: 'count', label: 'Referral count' }]
              : [{ value: 'value', label: 'Fees collected' }, { value: 'count', label: 'Referral count' }, { value: 'conv', label: 'Conversion (Sent to Deed)' }];
            const countLine = total > TOP_N ? `Top ${TOP_N} of ${total}` : `${total} total`;
            const chart = (
              <Card key={key}>
                <CardHead
                  title={key === 'referrer' ? d.referrerTitle : key === 'branch' ? 'Volume by branch' : 'Volume by agency'}
                  sub={`${measureLabel(measure[key])} · ${scope}`}
                  actions={
                    <MeasureSelect
                      ariaLabel={`Measure for volume by ${key}`}
                      value={measure[key]}
                      onChange={(v) => setMeasure((m) => ({ ...m, [key]: v as Measure }))}
                      options={options}
                    />
                  }
                />
                <CardBody>
                  <BarChart rows={bars} topIndex={0} max={max} />
                </CardBody>
                <CardFoot>
                  <span className="muted" style={{ fontSize: 12.5 }}>{countLine}</span>
                  <Button variant="quiet" size="sm" to={`/league?view=${key}`} arrow>View all</Button>
                </CardFoot>
              </Card>
            );
            if (key === 'referrer') return chart;
            return (
              <RoleOnly key={key} roles={['superadmin', 'management']}>
                {chart}
              </RoleOnly>
            );
          })}
        </section>

        {/* MONTHLY TREND */}
        <RoleOnly roles={['superadmin', 'management']}>
          <Card style={{ marginBottom: 18 }}>
            <CardHead
              title="Monthly volume trend"
              sub={trendSub}
              actions={
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <TrendSelect
                    ariaLabel="Break the trend down by"
                    value={trendView}
                    onChange={(v) => setTrendView(v as TrendView)}
                    options={[{ value: 'month', label: 'By month' }, { value: 'branch', label: 'By branch' }, { value: 'agency', label: 'By agency' }, { value: 'referrer', label: 'By referrer' }]}
                  />
                  <TrendSelect
                    ariaLabel="Measure for the trend"
                    value={trendMeasure}
                    onChange={(v) => setTrendMeasure(v as TrendMeasure)}
                    options={[{ value: 'commission', label: 'Commission earned' }, { value: 'value', label: 'Fees collected' }, { value: 'count', label: 'Referral count' }]}
                  />
                </div>
              }
            />
            <CardBody>
              <BarChart rows={trendRows} topIndex={trendTopIndex} />
            </CardBody>
          </Card>
        </RoleOnly>

        {/* SETTLEMENTS (below performance) — payable totals; applications collapsed. */}
        {(naSettlements || (d.live && (settlement.partners.length > 0 || agentSettlement.agencies.length > 0))) && (
          <RoleOnly roles={['superadmin', 'management']}>
            <div id="settlements" className="section-label"><Eyebrow>Settlements</Eyebrow></div>
          </RoleOnly>
        )}

        {/* COMMISSION SETTLEMENT (partner, prior calendar month, payable the 15th) */}
        {d.live && settlement.partners.length > 0 && (
          <RoleOnly roles={['superadmin', 'management']}>
            <section className="card settle">
              <div className="settle__head">
                <div>
                  <div className="kpi__label">Partner commission settlement</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                    Partner commission accrued on payments in <b>{settlement.monthLabel}</b> (calendar month, net of refunds), payable on <b>{settleDate}</b>.
                  </div>
                </div>
              </div>
              {settlement.partners.map((p) => (
                <div key={p.partner} className="settle__partner">
                  <div className="settle__row">
                    <span>Commission payable to <b>{p.partnerName}</b></span>
                    <span className="settle__amt">{gbpPence(p.commission)}</span>
                  </div>
                  <details className="settle__exp">
                    <summary>Show applications ({p.apps.length})</summary>
                    <div className="settle__apps">
                      <table>
                        <thead>
                          <tr><th>Reference</th><th>Branch</th><th className="num">Paid</th><th className="num">Fee</th><th className="num">Commission</th></tr>
                        </thead>
                        <tbody>
                          {p.apps.map((ap) => (
                            <tr key={ap.ref}>
                              <td>{ap.ref}</td>
                              <td>{ap.branch}{ap.agency ? ` · ${ap.agency}` : ''}</td>
                              <td className="num">{dmyShort(ap.paidAt)}</td>
                              <td className="num">{gbpPence(ap.rent)}</td>
                              <td className="num">{gbpPence(ap.commission)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </div>
              ))}
            </section>
          </RoleOnly>
        )}

        {/* AGENT COMMISSION SETTLEMENT (agency level, prior calendar month, payable the 15th) */}
        {d.live && agentSettlement.agencies.length > 0 && (
          <RoleOnly roles={['superadmin', 'management']}>
            <section className="card settle">
              <div className="settle__head">
                <div>
                  <div className="kpi__label">Agent commission settlement</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                    Agent commission accrued on payments in <b>{agentSettlement.monthLabel}</b> (calendar month, net of refunds), payable to each agency on <b>{agentSettleDate}</b>.
                  </div>
                </div>
              </div>
              <div className="settle__row settle__row--agg">
                <span>Agent commission due <b>{settleDayMonth}</b> across <b>{agentSettlement.agencies.length}</b> {agentSettlement.agencies.length === 1 ? 'agency' : 'agencies'}</span>
                <span className="settle__amt">{gbpPence(agentDue)}</span>
              </div>
              {agentTop.map(agentAgencyRow)}
              {agentRest.length > 0 && (
                <details className="settle__exp settle__exp--more">
                  <summary>View all {agentSettlement.agencies.length} agencies</summary>
                  {agentRest.map(agentAgencyRow)}
                </details>
              )}
            </section>
          </RoleOnly>
        )}

        {/* SUPPORT METRICS */}
        <div className="section-label"><Eyebrow>Operational health</Eyebrow></div>
        <section className="supportrow">
          <div className="card smetric">
            <div className="kpi__label">Average monthly rent</div>
            <div className="kpi__value" style={{ marginTop: 10 }}>{d.rent}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>Across all referred tenancies</div>
          </div>
          <div className="card smetric">
            <div className="kpi__label">Avg. time Sent → Payment</div>
            <div className="kpi__value" style={{ marginTop: 10 }}>{d.avgSentToPaid} <span className="unit">days</span></div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>From referral sent to fee paid</div>
          </div>
          <div className="card smetric">
            <div className="kpi__label">Avg. time Payment → Deed</div>
            <div className="kpi__value" style={{ marginTop: 10 }}>{d.avgPaidToDeed} <span className="unit">days</span></div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>From fee paid to deed issued</div>
          </div>
        </section>
      </div>

      {/* APPLICATION EXPORT MODAL (Management + opndoor admin) */}
      {appsOpen && role !== 'referrer' && (
        <div className="bdx-scrim is-open" onMouseDown={(e) => e.target === e.currentTarget && setAppsOpen(false)}>
          <div className="bdx" role="dialog" aria-modal="true">
            <div className="bdx__head">
              <div>
                <div className="bdx__title">Application export</div>
                <div className="bdx__sub">One pseudonymised row per application, for the period selected on the dashboard. Choose what the period filters on.</div>
              </div>
              <button className="bdx__close" aria-label="Close" onClick={() => setAppsOpen(false)}><Icon name="x" /></button>
            </div>
            <div className="bdx__body">
              <div className="field">
                <label htmlFor="apps-basis">Filter the period by</label>
                <select id="apps-basis" value={appsBasis} onChange={(e) => setAppsBasis(e.target.value as ExportBasis)}>
                  <option value="referred">Date referred (Sent) — reconciles to Referrals sent</option>
                  <option value="paid">Date paid — reconciles to fees collected</option>
                  <option value="deed">Date deed issued — reconciles to Deeds issued</option>
                  <option value="activity">All activity — everything Sent, Paid or Deed issued in the period</option>
                </select>
                <span className="hint">{BASIS_META[appsBasis].hint}</span>
              </div>
              <div className="bdx__warn" style={{ background: 'var(--white-lilac)', borderColor: 'rgba(211,100,251,0.25)' }}>
                <Icon name="info" />
                <span>Each row always shows the application's latest status and its paid and deed dates whenever they occurred, so a referral made one month and paid the next is captured on the "Date paid" basis for the month it was paid.</span>
              </div>
            </div>
            <div className="bdx__foot">
              <Button variant="ghost" onClick={() => setAppsOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={runAppsExport}>Export</Button>
            </div>
          </div>
        </div>
      )}

      {/* #86 EXPIRIES MODAL (management + opndoor admin) */}
      {expOpen && (role === 'superadmin' || role === 'management') && (
        <div className="bdx-scrim is-open" onMouseDown={(e) => e.target === e.currentTarget && setExpOpen(false)}>
          <div className="bdx" role="dialog" aria-modal="true">
            <div className="bdx__head">
              <div>
                <div className="bdx__title">Expiring guarantees</div>
                <div className="bdx__sub">Every in-force guarantee expiring in the chosen month, soonest first. {role === 'superadmin' ? 'All partners.' : 'Your partner only.'} Already-expired guarantees are never shown.</div>
              </div>
              <button className="bdx__close" aria-label="Close" onClick={() => setExpOpen(false)}><Icon name="x" /></button>
            </div>
            <div className="bdx__body">
              <div className="field">
                <label htmlFor="exp-month">Month (by guarantee expiry date)</label>
                <input type="month" id="exp-month" min="2024-09" max="2028-12" value={expMonth} onChange={(e) => setExpMonth(e.target.value)} />
              </div>
              <div className="bdx__warn" style={{ background: 'var(--white-lilac)', borderColor: 'rgba(211,100,251,0.25)' }}>
                <Icon name="info" />
                <span>Columns: guarantee reference, tenant name, property address, agency and branch, tenancy start, expiry date, days remaining, monthly and annualised rent, and referrer. Management receive this cohort by email six weeks before the month begins.</span>
              </div>
            </div>
            <div className="bdx__foot">
              <Button variant="ghost" onClick={() => setExpOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={runExpiries}>Download expiries</Button>
            </div>
          </div>
        </div>
      )}

      {/* BORDEREAU MODAL (opndoor admin only) */}
      {bdxOpen && role === 'superadmin' && (
        <div className="bdx-scrim is-open" onMouseDown={(e) => e.target === e.currentTarget && setBdxOpen(false)}>
          <div className="bdx" role="dialog" aria-modal="true">
            <div className="bdx__head">
              <div>
                <div className="bdx__title">Monthly bordereau</div>
                <div className="bdx__sub">Underwriter export (C&amp;C format) with full tenant details, for one calendar month by tenancy start date. opndoor admin only.</div>
              </div>
              <button className="bdx__close" aria-label="Close" onClick={() => setBdxOpen(false)}><Icon name="x" /></button>
            </div>
            <div className="bdx__body">
              <div className="field">
                <label htmlFor="bdx-month">Month (by tenancy start date)</label>
                <input type="month" id="bdx-month" min="2024-09" max="2026-12" value={bdxMonth} onChange={(e) => setBdxMonth(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="bdx-rate">Insurance rate applied to every row</label>
                <div className="bdx__rate">
                  <input type="number" id="bdx-rate" step="0.1" min="0" max="100" value={bdxRate} onChange={(e) => setBdxRate(e.target.value)} />
                  <span>%</span>
                </div>
                <span className="hint">
                  {(() => { const m = getBordereauRateMeta(); return `Current rate: ${m.rate}%${m.changedAt ? ` · last changed ${dmyShort(m.changedAt)} by ${m.changedBy ?? 'an administrator'}` : ' (default)'}.`; })()}
                  {' '}Changing it here saves the new rate for future exports and records who changed it and when.
                </span>
              </div>
              <div className="bdx__warn">
                <Icon name="alert" />
                <span>Contains full tenant personal data. For the underwriter only. Never share with partner users.</span>
              </div>
            </div>
            <div className="bdx__foot">
              <Button variant="ghost" onClick={() => setBdxOpen(false)} disabled={bdxBusy}>Cancel</Button>
              <Button variant="primary" onClick={exportBordereau} disabled={bdxBusy}>{bdxBusy ? 'Saving…' : 'Export bordereau'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
