/* =====================================================================
   League tables — the full ranked lists behind the dashboard breakdowns.
   Tabs for Agencies, Branches and Referrers; sortable by any column,
   searchable, and paged at 15 rows. Respects role + partner scoping, with
   a partner filter for opndoor admin. Deep-linked via ?view=.

   Data comes from getLeague (the service). Sorting, searching and paging
   are presentation concerns handled here.
   ===================================================================== */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { buildLeagueDoc, exportBranded, fmtBig, getLeague, getPartners, type LeagueRow, type LeagueView } from '@/data';
import { useSession } from '@/session/SessionContext';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Card, CardFoot } from '@/components/ui/Card';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { RoleOnly } from '@/components/ui/RoleOnly';
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
  usePageMeta('league', 'League tables', ['Home', 'League tables']);
  const { role, partnerScope, period } = useSession();
  const [params] = useSearchParams();

  const initialView = (params.get('view') as LeagueView) || 'agency';
  const [view, setView] = useState<LeagueView>(COLS[initialView] ? initialView : 'agency');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('fees');
  const [dir, setDir] = useState<-1 | 1>(-1);
  const [page, setPage] = useState(0);
  const [partner, setPartner] = useState('');

  const cols = COLS[view];
  const all = getLeague(view, { role, scope: partnerScope, partner, period });

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
          <Eyebrow>Performance</Eyebrow>
          <h1 className="page-head__title" style={{ marginTop: 10 }}>League tables</h1>
          <p className="page-head__sub">Every agency, branch and referrer ranked in full. Search, sort by any metric, and page through the whole book. The dashboard shows the top ten; this is the complete list.</p>
        </div>
        <div className="page-head__actions">
          <Button variant="dark" size="sm" onClick={() => void exportBranded(buildLeagueDoc(role, partnerScope, partner, period))} title="Downloads all three league tables as a branded Excel workbook">
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
          <span className="fchip">
            <Icon name="shield" />Partner:{' '}
            <select value={partner} onChange={(e) => { setPartner(e.target.value); setPage(0); }}>
              <option value="">All partners</option>
              {getPartners().map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </span>
        </RoleOnly>
        <span className="lt-count">Showing <b>{total ? `${start + 1}-${Math.min(start + PAGE, total)}` : '0'}</b> of <b>{total}</b></span>
      </div>

      <Card>
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th className="num" style={{ width: 44 }}>#</th>
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
                return (
                  <tr key={`${r.name}-${r.sub}`}>
                    <td className="num"><span className={`rank${rank <= 3 ? ' top' : ''}`}>{rank}</span></td>
                    {cols.map((c, ci) =>
                      ci === 0 ? (
                        <td key={c[0]}><div className="lt-name">{r.name}</div><div className="lt-sub">{r.sub}</div></td>
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
