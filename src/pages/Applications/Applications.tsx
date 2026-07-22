/* =====================================================================
   Applications — every referral, filterable and searchable. Status tabs,
   search, agency/branch filters, a partner column + filter (opndoor admin),
   the drill-through banner when arriving from Agencies & branches, and row
   click through to the detail view. Partner isolation + the referrer
   "own referrals only" rule live in applicationsService.
   ===================================================================== */
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  agencyNamesForScope, agencyOfBranch, branchNamesForScope, countByStatus, getApplications, getPartners,
  partnerName, referrerNamesForScope, getPeriods, periodRange, ALL_PARTNERS, type Status, type Period,
} from '@/data';
import { useSession } from '@/session/SessionContext';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Card } from '@/components/ui/Card';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Pill, type PillVariant } from '@/components/ui/Pill';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { RoleOnly } from '@/components/ui/RoleOnly';
import { RoleNote } from '@/components/ui/RoleNote';
import { Pager } from '@/components/ui/Pager';
import './Applications.css';

const PAGE_SIZE = 20;
const STATUS_LABEL: Record<Status, string> = { sent: 'Sent', paid: 'Paid', deed: 'Deed Issued', withdrawn: 'Withdrawn', expired: 'Expired' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function initials(name: string): string {
  return name.split(' ').map((p) => p[0]).slice(0, 2).join('');
}

/** A filter pill whose WHOLE surface is the trigger: a transparent select is
    overlaid across the pill, so clicking the label, value or caret opens it. */
function FilterChip({ icon, label, display, value, onChange, children }: {
  icon: ReactNode;
  label: string;
  display: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
}) {
  return (
    <span className="fchip">
      {icon}
      <span className="fchip__text">{label} <b>{display}</b></span>
      <Icon name="chevronDown" className="fchip__caret" />
      <select value={value} onChange={onChange} aria-label={label}>{children}</select>
    </span>
  );
}

export function Applications() {
  usePageMeta('applications', 'Applications', ['Home', 'Applications']);
  const { role, partnerScope } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // Initial filters from the drill-through URL (?agency= / ?branch= / ?status= / ?deed=).
  // 'refunded' and 'awaiting' are status chips that cross-cut Paid (status stays Paid).
  const [status, setStatus] = useState<Status | 'all' | 'refunded' | 'awaiting' | 'delivery-failed' | 'withdrawn' | 'expired'>(() => {
    if (params.get('deed') === 'awaiting') return 'awaiting';
    // #93 delivery-failed is management + opndoor admin only.
    if (role !== 'referrer' && params.get('deed') === 'delivery-failed') return 'delivery-failed';
    const s = params.get('status');
    return s === 'sent' || s === 'paid' || s === 'deed' || s === 'refunded' || s === 'withdrawn' || s === 'expired' ? s : 'all';
  });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('Newest first');
  const [partner, setPartner] = useState('');
  const [agency, setAgency] = useState(() => params.get('agency') || (params.get('branch') ? agencyOfBranch(params.get('branch')!) : ''));
  const [branch, setBranch] = useState(() => params.get('branch') || '');
  // #owner Referrer filter (management + opndoor admin only). Referrers only ever
  // see their own applications, so the filter is never offered to them and a
  // ?referrer= they craft is ignored (scopedSet already restricts them to owner rows).
  const [referrer, setReferrer] = useState(() => (role !== 'referrer' ? params.get('referrer') || '' : ''));
  // #owner Period filter — the dashboard's options, bucketed on sent date. Defaults
  // to All time so the page's default view (every application) is unchanged.
  const periods = getPeriods();
  const [period, setPeriod] = useState<Period>(() => periods.find((p) => p.id === 'alltime') || periods[periods.length - 1]);
  const range = useMemo(() => periodRange(period), [period]);

  // Reset partner/agency/branch/referrer when the role changes (partner isolation), skipping first run.
  const firstRole = useRef(true);
  useEffect(() => {
    if (firstRole.current) {
      firstRole.current = false;
      return;
    }
    setPartner('');
    setAgency('');
    setBranch('');
    setReferrer('');
  }, [role]);

  // const scopeOpts = { role, scope: partnerScope, partner: partner || undefined };

  const effectiveScope = role === 'superadmin' ? ALL_PARTNERS : partnerScope;
  const scopeOpts = { role, scope: effectiveScope, partner: partner || undefined };
  // #owner Chips recount within the selected period and the current filter state.
  const counts = countByStatus({ ...scopeOpts, agency: agency || undefined, branch: branch || undefined, referrer: referrer || undefined, periodRange: range });
  // #13: the "Showing X of Y" denominator must match the active status tab.
  // Withdrawn/Expired are terminal and excluded from counts.all, so on those tabs
  // Y must be the tab's own count, not the operational total.
  const total = (counts as Record<string, number>)[status] ?? counts.all;
  const visibleRows = useMemo(
    () => getApplications({ ...scopeOpts, status, agency: agency || undefined, branch: branch || undefined, referrer: referrer || undefined, q, sort, periodRange: range }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [role, partnerScope, partner, status, agency, branch, referrer, q, sort, period],
  );

  // Pagination. Reset to the first page whenever the filtered set changes, and
  // clamp if the current page fell off the end (e.g. after narrowing filters).
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [role, partnerScope, partner, status, agency, branch, referrer, q, sort, period]);
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pagedRows = visibleRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const agencyOptions = agencyNamesForScope(scopeOpts);
  const branchOptions = branchNamesForScope(scopeOpts, agency || undefined);
  const referrerOptions = referrerNamesForScope(scopeOpts);
  const showPartner = role === 'superadmin';
  const showReferrer = role !== 'referrer';

  const tabs = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'sent', label: <Pill variant="sent" style={{ background: 'none', padding: 0 }}>Sent</Pill>, count: counts.sent },
    { id: 'paid', label: <Pill variant="paid" style={{ background: 'none', padding: 0 }}>Paid</Pill>, count: counts.paid },
    { id: 'deed', label: <Pill variant="deed" style={{ background: 'none', padding: 0 }}>Deed Issued</Pill>, count: counts.deed },
    // Refunded cross-cuts Paid (the fee was refunded; status stays Paid). Counted
    // separately, so All still equals Sent + Paid + Deed, not their sum plus this.
    { id: 'refunded', label: <Pill variant="danger" style={{ background: 'none', padding: 0 }}>Refunded</Pill>, count: counts.refunded },
    // Awaiting signature: deed out for signature (a sub-state of Paid). Shown when
    // there is anything awaiting, or when the filter is already active (deep-link).
    ...(counts.awaiting > 0 || status === 'awaiting'
      ? [{ id: 'awaiting', label: <Pill variant="warn" style={{ background: 'none', padding: 0 }}>Awaiting signature</Pill>, count: counts.awaiting }]
      : []),
    // Delivery failed: deed issued but not delivered to an agent contact (#84).
    // Ops surface, management + opndoor admin only (#93). Shown when there is
    // anything to resend, or when the filter is deep-linked.
    ...(role !== 'referrer' && (counts.deliveryFailed > 0 || status === 'delivery-failed')
      ? [{ id: 'delivery-failed', label: <Pill variant="warn" style={{ background: 'none', padding: 0 }}>Delivery failed</Pill>, count: counts.deliveryFailed }]
      : []),
    // #2 Withdrawn: terminal, out of the funnel (excluded from All/Sent). Shown when
    // any exist or when deep-linked, so it never crowds the tabs when unused.
    ...(counts.withdrawn > 0 || status === 'withdrawn'
      ? [{ id: 'withdrawn', label: <Pill variant="muted" style={{ background: 'none', padding: 0 }}>Withdrawn</Pill>, count: counts.withdrawn }]
      : []),
    // #13 Expired: terminal (unpaid 14 days after Sent). Same closed/withdrawn family.
    ...(counts.expired > 0 || status === 'expired'
      ? [{ id: 'expired', label: <Pill variant="muted" style={{ background: 'none', padding: 0 }}>Expired</Pill>, count: counts.expired }]
      : []),
  ];

  const activeFilter = branch
    ? <>Showing applications for the <b>{branch}</b> branch{agency ? <> at <b>{agency}</b></> : null}</>
    : agency
      ? <>Showing applications for <b>{agency}</b> (all branches)</>
      : referrer
        ? <>Showing applications referred by <b>{referrer}</b></>
        : null;

  return (
    <>
      <div className="page-head">
        <div>
          <Eyebrow>Tracking</Eyebrow>
          <h1 className="page-head__title" style={{ marginTop: 10 }}>Applications</h1>
          <p className="page-head__sub">Every referral from sent through to deed issued. Filter by status, agency or branch, or search by tenant.</p>
        </div>
        <RoleOnly roles={['superadmin', 'referrer']}>
          <div className="page-head__actions">
            <Button variant="primary" size="sm" to="/new-application"><Icon name="plus" /> New application</Button>
          </div>
        </RoleOnly>
      </div>

      <RoleOnly roles={['referrer']}>
        <RoleNote style={{ marginBottom: 18 }}>
          Showing <b>your referrals only</b>. You can track every application you have sent.
        </RoleNote>
      </RoleOnly>

      {activeFilter && (
        <div className="active-filter">
          <Icon name="filter" className="lead" />
          <span>{activeFilter}</span>
          <button className="active-filter__clear" onClick={() => { setAgency(''); setBranch(''); setReferrer(''); }}>
            <Icon name="x" />Clear filter
          </button>
        </div>
      )}

      <div className="toolbar">
        <FilterTabs tabs={tabs} active={status} onChange={(id) => setStatus(id as Status | 'all' | 'refunded' | 'awaiting' | 'delivery-failed' | 'withdrawn' | 'expired')} />
      </div>

      <div className="toolbar">
        <div className="toolbar__search">
          <Icon name="search" />
          <input type="text" placeholder="Search by tenant, property or reference" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="filterchips">
          <FilterChip icon={<Icon name="calendar" />} label="Period:" display={period.label} value={period.id}
            onChange={(e) => setPeriod(periods.find((p) => p.id === e.target.value) || period)}>
            {periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </FilterChip>
          {showPartner && (
           <FilterChip
                icon={<Icon name="shield" />}
                label="Partner:"
                display={!partner || partner === ALL_PARTNERS ? 'All' : partnerName(partner)}
                value={partner}
                onChange={(e) => {
                  setPartner(e.target.value);
                  setAgency('');
                  setBranch('');
                  setReferrer('');
                }}
              >
                <option value="">All</option>
                {getPartners().map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </FilterChip>
          )}
          <FilterChip icon={<Icon name="building" />} label="Agency:" display={agency || 'All'} value={agency}
            onChange={(e) => { setAgency(e.target.value); setBranch(''); }}>
            <option value="">All</option>
            {agencyOptions.map((n) => <option key={n} value={n}>{n}</option>)}
          </FilterChip>
          <FilterChip icon={<Icon name="home" />} label="Branch:" display={branch || (agency ? 'All branches' : 'All')} value={branch}
            onChange={(e) => setBranch(e.target.value)}>
            <option value="">{agency ? 'All branches' : 'All'}</option>
            {branchOptions.map((n) => <option key={n} value={n}>{n}</option>)}
          </FilterChip>
          {showReferrer && (
            <FilterChip icon={<Icon name="users" />} label="Referrer:" display={referrer || 'All'} value={referrer}
              onChange={(e) => setReferrer(e.target.value)}>
              <option value="">All</option>
              {referrerOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </FilterChip>
          )}
          <FilterChip icon={<Icon name="chevronDown" />} label="Sort:" display={sort} value={sort}
            onChange={(e) => setSort(e.target.value)}>
            <option>Newest first</option>
            <option>Oldest first</option>
            <option>Rent: high to low</option>
          </FilterChip>
        </div>
        <span className="countline">Showing <b>{visibleRows.length}</b> of <b>{total}</b></span>
      </div>

      <Card>
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Tenant</th>
                {showPartner && <th>Partner</th>}
                <th>Property</th>
                <th>Branch</th>
                <th style={{ textAlign: 'right' }}>Monthly rent</th>
                <th>Status</th>
                <th>Date</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((r) => (
                <tr key={r.ref} onClick={() => navigate(`/applications/${encodeURIComponent(r.ref)}`)}>
                  <td>
                    <div className="who">
                      <span className="who__av">{initials(r.tenant)}</span>
                      <div><div className="dt__name">{r.tenant}</div><div className="dt__sub">{r.ref}</div></div>
                    </div>
                  </td>
                  {showPartner && <td>{partnerName(r.partner)}</td>}
                  <td>{r.prop}</td>
                  <td>{r.branch}<div className="dt__sub">{r.agency}</div></td>
                  <td style={{ textAlign: 'right' }}><span className="dt__rent">£{r.rent.toLocaleString('en-GB')}</span><div className="dt__sub">per month</div></td>
                  <td><span className="status-cell"><Pill variant={r.status === 'withdrawn' || r.status === 'expired' ? 'muted' : (r.status as PillVariant)}>{STATUS_LABEL[r.status]}</Pill>{r.refunded && <span className="refund-tag" title="Guarantor fee refunded">Refunded</span>}</span></td>
                  <td className="dt__num soft">{fmtDate(r.date)}</td>
                  <td><Icon name="chevronRight" className="dt__chev" size={16} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visibleRows.length === 0 && <div className="empty is-shown">No applications match your filters.</div>}
        <Pager page={safePage} pageSize={PAGE_SIZE} total={visibleRows.length} onPage={setPage} noun="applications" />
      </Card>
    </>
  );
}
