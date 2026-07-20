/* =====================================================================
   League tables — the full ranked lists behind the dashboard breakdowns.

   Management / opndoor admin: tabs for Agencies, Branches and Referrers;
   sortable, searchable, paged, with a partner filter for opndoor admin.

   Referrers (#79): a single own-partner Referrers board (no Agencies/Branches
   tabs, no export), showing positions and referral counts. Fees collected are
   shown only when their partner's setting is "Full"; commission is never shown.
   The per-partner setting (Full / Rankings only / Private, #88) is edited by
   opndoor admin in Manage partner; Management edits it here for their own partner
   (they cannot reach the admin-only Manage partner screen), and admin sees it
   read-only here.

   Data comes from getLeague / getReferrerLeague (the service). Sorting,
   searching and paging are presentation concerns handled here.
   ===================================================================== */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ALL_PARTNERS, buildLeagueDoc, exportBranded, fmtBig, getLeague, getPartners, getPeriods, partnerName,
  getReferrerLeague,
  type LeagueRow, type LeagueView, type ReferrerBoard, type Period,
} from '@/data';
import { useSession } from '@/session/SessionContext';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Card, CardFoot } from '@/components/ui/Card';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { RoleOnly } from '@/components/ui/RoleOnly';
import { PartnerSelect, PeriodSelect } from '@/components/ui/Select';
import './League.css';

const PAGE = 15;
type SortKey = keyof Pick<LeagueRow, 'name' | 'refs' | 'fees' | 'paid' | 'deed' | 'sp' | 'conv' | 'partnerComm' | 'agentComm'>;
type Col = [SortKey, string, boolean]; // [key, label, sortable]

const COLS: Record<LeagueView, Col[]> = {
  agency: [['name', 'Agency', false], ['refs', 'Referrals', true], ['fees', 'Fees collected', true], ['paid', 'Paid', true], ['deed', 'Deeds', true], ['sp', 'Sent to Paid', true], ['conv', 'Sent to Deed', true], ['partnerComm', 'Partner comm.', true], ['agentComm', 'Agent comm.', true]],
  branch: [['name', 'Branch', false], ['refs', 'Referrals', true], ['fees', 'Fees collected', true], ['paid', 'Paid', true], ['deed', 'Deeds', true], ['sp', 'Sent to Paid', true], ['conv', 'Sent to Deed', true], ['partnerComm', 'Partner comm.', true], ['agentComm', 'Agent comm.', true]],
  referrer: [['name', 'Referrer', false], ['refs', 'Referrals', true], ['fees', 'Fees collected', true], ['paid', 'Paid', true], ['deed', 'Deeds', true], ['sp', 'Sent to Paid', true], ['conv', 'Sent to Deed', true]],
};

const TABS: { id: LeagueView; label: string }[] = [
  { id: 'agency', label: 'Agencies' },
  { id: 'branch', label: 'Branches' },
  { id: 'referrer', label: 'Referrers' },
];


function ConvChip({ cv }: { cv: number }) {
  const cls = cv >= 0.7 ? '' : cv >= 0.6 ? 'mid' : 'low';
  return (
    <span className="conv-chip">
      <span className={`conv-dot ${cls}`} />
      {Math.round(cv * 100)}%
    </span>
  );
}

function cellFor(col: SortKey, r: LeagueRow) {
  switch (col) {
    case 'refs': return r.refs.toLocaleString('en-GB');
    case 'fees': return fmtBig(r.fees);
    case 'deed': return r.deed.toLocaleString('en-GB');
    case 'paid': return r.paid.toLocaleString('en-GB');
    case 'sp': return <ConvChip cv={r.sp} />;
    case 'conv': return <ConvChip cv={r.conv} />;
    case 'partnerComm': return fmtBig(r.partnerComm);
    case 'agentComm': return fmtBig(r.agentComm);
    default: return r.name;
  }
}

export function League() {
  const { role } = useSession();
  // Referrers get a restricted own-partner board; everyone else the full tables.
  return role === 'referrer' ? <ReferrerLeagueView /> : <FullLeagueView />;
}

// #5 The League always opens on This calendar month (all roles), independent of
// the dashboard's period selection, then the user can change it locally.
function useLeaguePeriod(): [Period, (id: string) => void] {
  const periods = getPeriods();
  const [period, setPeriodState] = useState<Period>(() => periods.find((p) => p.id === 'thismonth') ?? periods[0]);
  return [period, (id: string) => setPeriodState(periods.find((p) => p.id === id) ?? periods[0])];
}

// #5/#107 Week-over-week rank movement (▲n up / ▼n down / – held / new = no prior
// standing, e.g. new entrant or no 7-day comparison yet). Rendered explicitly, never
// blank.
function Movement({ m }: { m: number | null }) {
  if (m == null) return <span className="lt-move lt-move--new" title="New, or no comparison 7 days ago">new</span>;
  if (m === 0) return <span className="lt-move lt-move--flat" title="No change">–</span>;
  const up = m > 0;
  return <span className={`lt-move ${up ? 'lt-move--up' : 'lt-move--down'}`} title={`${up ? 'Up' : 'Down'} ${Math.abs(m)} since last week`}>{up ? '▲' : '▼'}{Math.abs(m)}</span>;
}

// ---- Referrer view (#79): own-partner board, positions + counts (+ fees when Full). ----
function ReferrerLeagueView() {
  usePageMeta('league', 'League table', ['Home', 'League table']);
  const [period, setPeriod] = useLeaguePeriod();
  const [board, setBoard] = useState<ReferrerBoard | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getReferrerLeague(period)
      .then((b) => { if (alive) { setBoard(b); setLoading(false); } })
      .catch(() => { if (alive) { setBoard({ mode: 'full', rows: [] }); setLoading(false); } });
    return () => { alive = false; };
  }, [period]);

  const mode = board?.mode ?? 'full';
  const rows = board?.rows ?? [];
  const showFees = mode === 'full' || mode === 'private';
  const own = rows.find((r) => r.self) ?? rows[0];

  return (
    <>
      <div className="backbar" style={{ marginBottom: 16 }}>
        <Button variant="quiet" size="sm" to="/dashboard"><Icon name="arrowLeft" /> Back to dashboard</Button>
      </div>

      <div className="page-head">
        <div>
          <Eyebrow>Performance · {period.label}</Eyebrow>
          <h1 className="page-head__title" style={{ marginTop: 10 }}>Referrer leaderboard</h1>
          <p className="page-head__sub">
            {mode === 'private'
              ? 'Your own referral performance for the selected period.'
              : 'How you rank among referrers at your partner, by referrals sent in the selected period.'}
          </p>
        </div>
        <div className="page-head__actions">
          <PeriodSelect ariaLabel="League time period" value={period.id} onChange={setPeriod} options={getPeriods().map((p) => ({ value: p.id, label: p.label }))} />
        </div>
      </div>

      <Card>
        {loading ? (
          <div className="lt-empty is-shown">Loading…</div>
        ) : mode === 'private' ? (
          <div className="rl-own">
            <div className="rl-own__stat"><span className="rl-own__n">{(own?.refs ?? 0).toLocaleString('en-GB')}</span><span className="rl-own__l">Referrals sent</span></div>
            {showFees && <div className="rl-own__stat"><span className="rl-own__n">{fmtBig(own?.fees ?? 0)}</span><span className="rl-own__l">Fees collected</span></div>}
            <p className="rl-note">Your partner keeps the referrer leaderboard private, so only your own performance is shown.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th className="num" style={{ width: 44 }}>#</th>
                  <th style={{ width: 56 }} title="Movement since the same table 7 days ago">7d</th>
                  <th>Referrer</th>
                  <th className="num">Referrals</th>
                  {showFees && <th className="num">Fees collected</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.name}-${i}`} className={r.self ? 'is-self' : ''}>
                    <td className="num"><span className={`rank${i < 3 ? ' top' : ''}`}>{i + 1}</span></td>
                    <td><Movement m={r.movement} /></td>
                    <td><div className="lt-name">{r.name}{r.self && <span className="lt-partner">You</span>}</div></td>
                    <td className="num">{r.refs.toLocaleString('en-GB')}</td>
                    {showFees && <td className="num">{fmtBig(r.fees)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <div className="lt-empty is-shown">No referrals in this period yet.</div>}
          </div>
        )}
        {!loading && mode === 'rankings' && rows.length > 0 && (
          <CardFoot><span className="pager__info">Fees are hidden on this leaderboard.</span></CardFoot>
        )}
      </Card>
    </>
  );
}

// ---- Full view (management / opndoor admin): unchanged tables + the #79 setting. ----
function FullLeagueView() {
  usePageMeta('league', 'League tables', ['Home', 'League tables']);
  const { role, partnerScope } = useSession(); 
  const [period, setPeriod] = useLeaguePeriod();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const initialView = (params.get('view') as LeagueView) || 'agency';
  const [view, setView] = useState<LeagueView>(COLS[initialView] ? initialView : 'agency');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('fees');
  const [dir, setDir] = useState<-1 | 1>(-1);
  const [page, setPage] = useState(0);
  const [partner, setPartner] = useState(() => (partnerScope === ALL_PARTNERS ? '' : partnerScope));
  // Infer the ref type from the runtime value to avoid a missing-type error when
  // the PartnerScope type isn't available on the server build.
  const prevScope = useRef(partnerScope);

  useEffect(() => {
    if (partnerScope !== prevScope.current) {
      if (partner === prevScope.current) {
        setPartner(partnerScope === ALL_PARTNERS ? '' : partnerScope);
      }
      prevScope.current = partnerScope;
    }
  }, [partnerScope, partner]);

  // #114 Referrer-leaderboard visibility is set ONLY in Manage partner (the single
  // lever); the in-page control has been removed from the League screen.

  const cols = COLS[view];
  const activePartner = partnerScope === ALL_PARTNERS ? partner : partnerScope;
  const showPartner = partnerScope === ALL_PARTNERS && !partner;
  const all = getLeague(view, { role, scope: ALL_PARTNERS, partner: activePartner, period });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? all.filter((r) => `${r.name} ${r.sub}`.toLowerCase().includes(needle)) : all.slice();
    list.sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (sort === 'name') return dir * (av < bv ? -1 : av > bv ? 1 : 0);
      return dir * ((av as number) - (bv as number));
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, q, sort, dir]);

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const safePage = Math.min(page, pages - 1);
  const start = safePage * PAGE;
  const pageRows = filtered.slice(start, start + PAGE);

  function changeView(next: LeagueView) {
    setView(next);
    setPage(0);
    setSort('fees');
    setDir(-1);
  }
  function toggleSort(col: SortKey) {
    if (sort === col) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(col);
      setDir(col === 'name' ? 1 : -1);
    }
    setPage(0);
  }

  return (
    <>
      <div className="backbar" style={{ marginBottom: 16 }}>
        <Button variant="quiet" size="sm" to="/dashboard"><Icon name="arrowLeft" /> Back to dashboard</Button>
      </div>

      <div className="page-head">
        <div>
          {/* #100 Name the active scope truthfully (the table is scoped by the
              global partner selection even when the in-page selector is hidden). */}
          <Eyebrow>Performance · {period.label}{partner ? ` · ${partnerName(partner)}` : partnerScope !== ALL_PARTNERS ? ` · ${partnerName(partnerScope)}` : ''}</Eyebrow>
          <h1 className="page-head__title" style={{ marginTop: 10 }}>League tables</h1>
          <p className="page-head__sub">Every agency, branch and referrer ranked in full. Search, sort by any metric, and page through the whole book. The dashboard shows the top ten; this is the complete list.</p>
        </div>
        <div className="page-head__actions">
          <PeriodSelect ariaLabel="League time period" value={period.id} onChange={setPeriod} options={getPeriods().map((p) => ({ value: p.id, label: p.label }))} />
          {/* <Button variant="dark" size="sm" onClick={() => void exportBranded(buildLeagueDoc(role, partnerScope, partner, period))} title="Downloads all three league tables as a branded Excel workbook"> */}
          <Button variant="dark" size="sm" onClick={() => void exportBranded(buildLeagueDoc(role, partnerScope, partner, period))} title={`Downloads the ${TABS.find((t) => t.id === view)?.label} table as a branded Excel workbook`}>
            <Icon name="download" /> Export
          </Button>
        </div>
      </div>

      <div className="lt-toolbar">
        <div className="lt-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} className={`lt-tab${view === t.id ? ' is-active' : ''}`} role="tab" onClick={() => changeView(t.id)}>{t.label}</button>
          ))}
        </div>
      </div>

      <div className="lt-toolbar">
        <div className="lt-search">
          <Icon name="search" />
          <input type="text" placeholder="Search by name" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        </div>
        <RoleOnly roles={['superadmin']}>
          <PartnerSelect
            ariaLabel="Partner"
            value={partnerScope === ALL_PARTNERS ? (partner || ALL_PARTNERS) : partnerScope}
            onChange={(v) => { setPartner(v === ALL_PARTNERS ? '' : v); setPage(0); }}
            disabled={partnerScope !== ALL_PARTNERS}
            title={partnerScope !== ALL_PARTNERS ? 'This league view is already scoped by the selected partner.' : undefined}
            options={[{ value: ALL_PARTNERS, label: 'All partners' }, ...getPartners().map((p) => ({ value: p.id, label: p.name }))]}
          />
        </RoleOnly>
        <span className="lt-count">Showing <b>{total ? `${start + 1}-${Math.min(start + PAGE, total)}` : '0'}</b> of <b>{total}</b></span>
      </div>

      <Card>
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th className="num" style={{ width: 44 }}>#</th>
                <th style={{ width: 56 }} title="Movement since the same table 7 days ago">7d</th>
                {cols.map((c) => {
                  const [key, label, sortable] = c;
                  const isSort = sort === key;
                  return (
                    <th
                      key={key}
                      className={`${sortable ? 'sortable' : ''}${key !== 'name' ? ' num' : ''}${isSort ? ' is-sort' : ''}`}
                      onClick={sortable ? () => toggleSort(key) : undefined}
                    >
                      {label}
                      {sortable && <span className="sort-ar">{isSort && dir === 1 ? '▲' : '▼'}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r, i) => {
                const rank = start + i + 1;
                // #owner Drill through to the matching Applications filter (management +
                // opndoor admin view only — this table is the full view). Referrer rows
                // link to ?referrer=, exactly as agency/branch figures drill elsewhere.
                const drill = view === 'agency' ? `/applications?agency=${encodeURIComponent(r.name)}`
                  : view === 'branch' ? `/applications?branch=${encodeURIComponent(r.name)}`
                  : `/applications?referrer=${encodeURIComponent(r.name)}`;
                return (
                  <tr key={`${r.name}-${r.sub}`} onClick={() => navigate(drill)} style={{ cursor: 'pointer' }} title={`View applications for ${r.name}`}>
                    <td className="num"><span className={`rank${rank <= 3 ? ' top' : ''}`}>{rank}</span></td>
                    <td><Movement m={r.movement ?? null} /></td>
                    {cols.map((c, ci) =>
                      ci === 0 ? (
                        <td key={c[0]}>
                          <div className="lt-name">{r.name}{showPartner && r.partner ? <span className="lt-partner">{r.partner}</span> : null}</div>
                          <div className="lt-sub">{r.sub}</div>
                        </td>
                      ) : (
                        <td key={c[0]} className="num">{cellFor(c[0], r)}</td>
                      ),
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className={`lt-empty${total ? '' : ' is-shown'}`}>No matches.</div>
        <CardFoot>
          <div className="pager" style={{ width: '100%' }}>
            <span className="pager__info">Page {safePage + 1} of {pages}</span>
            <div className="pager__btns">
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}>Previous</Button>
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => p + 1)} disabled={safePage >= pages - 1}>Next</Button>
            </div>
          </div>
        </CardFoot>
      </Card>
    </>
  );
}
