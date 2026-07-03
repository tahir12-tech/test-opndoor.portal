/* =====================================================================
   Exports service (all GBP, dd/mm/yyyy, British). Rows are synthesised to
   match the modelled counts, exactly as the prototype does. Role gating is
   enforced here too, not just on the button: the application export is
   blocked for referrers, and the bordereau is opndoor-admin only.

   The three human-facing exports (Performance, Application, League) are
   branded .xlsx built from one shared template (xlsxTemplate.ts). The
   Bordereau stays a clean, unbranded CSV: its audience is the underwriter's
   import process, and branding risks breaking it.

   Live mode builds every figure from the hydrated live application set (the
   buildLive and buildReal paths), with the same scoping and gating; mock/test
   mode uses the parametric model. Both feed the same BrandedDoc blocks, so the
   export format is identical regardless of source.
   ===================================================================== */
import type { LeagueRow, LeagueView, PartnerScope, Period, Role } from './types';
import { ALL_PARTNERS } from './types';
import {
  ANNUAL, APP_BRANCHES, APP_RENTS, APP_REFERRERS, AVG_RENT,
  BX_FIRST, BX_FLATS, BX_LAST, BX_STREETS, BX_TITLES, TREND_MONTHS,
} from './mock/analyticsModel';
import { partnerName, getRatesFor, scopeFor } from './partnersService';
import { guaranteeExpiry, allFull, findRecord, type FullApp } from './applicationsService';
import { contactForApplication } from './orgService';
import { getLeague } from './leagueService';
import { SUPABASE_ENABLED } from '@/lib/supabase';
import { periodRange as realPeriodRange, scopeFull, basisInPeriod, inRange } from './paymentMetrics';
import { liveAvailable, liveAggregate, liveVolume, liveMonths, getCommissionSettlement, getAgentCommissionSettlement, livePartnerBreakdown } from './liveAnalytics';
// Type-only import: building the document specs needs no runtime code, so the
// heavy xlsx library is not pulled into the main bundle. It is dynamically
// imported in exportBranded, on demand, when an export is actually run.
import type { BrandedDoc, Column, TableRow } from './xlsxTemplate';

/** A named branded sheet + the download filename (the xlsx-free document spec). */
export interface BrandedExport {
  sheets: { name: string; doc: BrandedDoc }[];
  filename: string;
}

/** Generated-date stamp for the metadata line (dd/mm/yyyy, British). */
function generatedOn(): string {
  return new Date().toLocaleDateString('en-GB');
}

/**
 * Build and download a branded workbook. Lazily loads the xlsx library so it
 * is fetched only when a user runs an export, not on first paint.
 */
export async function exportBranded(built: BrandedExport): Promise<void> {
  const { buildBrandedWorkbook, downloadXlsx } = await import('./xlsxTemplate');
  downloadXlsx(buildBrandedWorkbook(built.sheets), built.filename);
}

const DAY = 86400000;
const TODAY = new Date(2026, 5, 26);
const ALLTIME_START = new Date(2024, 8, 1);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function dmy(x: Date): string {
  return `${pad(x.getDate())}/${pad(x.getMonth() + 1)}/${x.getFullYear()}`;
}
function gbp(n: number): string {
  return `£${Math.round(n).toLocaleString('en-GB')}`;
}
function addDays(x: Date, n: number): Date {
  return new Date(x.getTime() + n * DAY);
}

function periodRange(p: Period): [Date, Date] {
  if (p.id === 'thismonth') return [new Date(2026, 5, 1), new Date(2026, 5, 30)];
  if (p.id === 'lastmonth') return [new Date(2026, 4, 1), new Date(2026, 4, 31)];
  if (p.id === 'last7') return [addDays(TODAY, -6), TODAY];
  if (p.id === 'last30') return [addDays(TODAY, -29), TODAY];
  if (p.id === 'last90') return [addDays(TODAY, -89), TODAY];
  if (p.id === 'last12m') return [new Date(2025, 5, 27), TODAY];
  return [ALLTIME_START, TODAY];
}

type CsvRow = (string | number)[];
function toCSV(rows: CsvRow[]): string {
  return rows.map((r) => r.map((s) => `"${String(s).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

/** Trigger a browser download of a CSV string. Written UTF-8 with a BOM so Excel
    reads £ and accented characters correctly (without the BOM it assumes the
    legacy locale codepage and mangles them). */
export function downloadCsv(csv: string, name: string): void {
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

interface EntityRow {
  name: string;
  parent: string;
  sent: number;
  paid: number;
  deed: number;
  fees: number;
}
interface ExportModel {
  sent: number;
  paid: number;
  deed: number;
  fees: number;
  stuckSent: number;
  stuckPaid: number;
  agencies: EntityRow[];
  branches: EntityRow[];
  referrers: EntityRow[];
}

function exportModel(role: Role, period: Period): ExportModel {
  const isRef = role === 'referrer';
  const sent = isRef ? Math.max(1, Math.round(period.fSent * (38 / 342))) : period.fSent;
  const paid = Math.round(sent * period.sp);
  const deed = Math.round(paid * period.pd);
  const fees = paid * AVG_RENT;
  const kc = sent / (isRef ? 38 : 342);
  const stuckSent = Math.round((isRef ? 8 : 74) * kc);
  const stuckPaid = Math.round((isRef ? 3 : 27) * kc);
  const shape = isRef
    ? { agencies: [['Foxglove Residential', 38, 88000]], branches: [['South Kensington', 16, 37000, 'Foxglove Residential'], ['Chelsea', 13, 34000, 'Foxglove Residential'], ['Fulham', 9, 18000, 'Foxglove Residential']], referrers: [['April', 14, 32000], ['March', 13, 30000], ['February', 11, 27000]] }
    : { agencies: [['Foxglove Residential', 214, 246240], ['Marylebone & Co', 152, 168000], ['Northbank Lettings', 108, 98000], ['Hartwell Estates', 96, 72000]], branches: [['South Kensington', 78, 169000, 'Foxglove Residential'], ['Marylebone', 72, 147000, 'Marylebone & Co'], ['Shoreditch', 63, 101000, 'Northbank Lettings'], ['Chelsea', 61, 153000, 'Foxglove Residential'], ['Clapham', 58, 82000, 'Hartwell Estates'], ['Fitzrovia', 54, 110000, 'Marylebone & Co']], referrers: [['Priya Nair', 38, 88000], ['James Okafor', 33, 82000], ['Sophie Bennett', 29, 63000], ['Daniel Wright', 24, 57000], ['Aisha Khan', 21, 45000], ['Marcus Lin', 17, 34000]] };
  const entity = (rows: (string | number)[][]): EntityRow[] =>
    rows.map((r) => {
      const es = Math.max(1, Math.round((r[1] as number) * kc));
      const ep = Math.round(es * period.sp);
      const ed = Math.round(ep * period.pd);
      return { name: r[0] as string, parent: (r[3] as string) || '', sent: es, paid: ep, deed: ed, fees: ep * AVG_RENT };
    });
  return { sent, paid, deed, fees, stuckSent, stuckPaid, agencies: entity(shape.agencies), branches: entity(shape.branches), referrers: entity(shape.referrers) };
}

function bands(total: number, shares: [number, number]): [number, number, number] {
  const a = Math.round(total * shares[0]);
  const b = Math.round(total * shares[1]);
  return [a, b, Math.max(0, total - a - b)];
}

function scopeLabel(role: Role): string {
  const sc = scopeFor(role);
  return sc === ALL_PARTNERS ? 'All partners (combined)' : partnerName(sc);
}

/** The metadata line under the title: period, scope, partner, generated date. */
function brandMeta(period: Period, scopeText: string, partnerLabel: string): string {
  const rng = periodRange(period);
  return `${period.label} (${dmy(rng[0])} to ${dmy(rng[1])}) · ${scopeText} · Partner: ${partnerLabel} · Generated ${generatedOn()} · GBP`;
}
function fileStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// Branch/agency/referrer breakdown table columns (Sent to Deed is a fraction for the pct format).
const BREAKDOWN_COLS = (first: string, showParent: boolean): Column[] => [
  { header: first, type: 'text' },
  ...(showParent ? [{ header: 'Parent agency', type: 'text' } as Column] : []),
  { header: 'Referrals', type: 'int' },
  { header: 'Fees collected', type: 'money' },
  { header: 'Sent', type: 'int' },
  { header: 'Paid', type: 'int' },
  { header: 'Deed issued', type: 'int' },
  { header: 'Sent to Deed', type: 'pct' },
];
function breakdownRows(list: EntityRow[], showParent: boolean): TableRow[] {
  return list.map((e) =>
    showParent
      ? [e.name, e.parent, e.sent, e.fees, e.sent, e.paid, e.deed, e.sent ? e.deed / e.sent : 0]
      : [e.name, e.sent, e.fees, e.sent, e.paid, e.deed, e.sent ? e.deed / e.sent : 0],
  );
}

/** Live performance export: every figure summed from the hydrated application set. */
function buildLivePerformanceDoc(role: Role, period: Period): BrandedExport {
  const scope = scopeFor(role);
  const a = liveAggregate(role, scope, period);
  const vol = liveVolume(role, scope, period);
  const r = getRatesFor(scope);
  const pPct = Math.round(r.partner * 100);
  const aPct = Math.round(r.agent * 100);
  // Live breakdown columns carry net commission per row (partner + agent), so the
  // agency/branch/referrer tables reconcile to the summary commission totals.
  const LIVE_BREAKDOWN_COLS = (first: string, showParent: boolean, comm: [string, string]): Column[] => [
    { header: first, type: 'text' },
    ...(showParent ? [{ header: 'Parent agency', type: 'text' } as Column] : []),
    { header: 'Referrals', type: 'int' },
    { header: 'Fees collected', type: 'money' },
    { header: 'Sent', type: 'int' },
    { header: 'Paid', type: 'int' },
    { header: 'Deed issued', type: 'int' },
    { header: 'Sent to Deed', type: 'pct' },
    { header: comm[0], type: 'money' },
    { header: comm[1], type: 'money' },
  ];
  const brk = (rows: LeagueRow[], showParent: boolean): TableRow[] =>
    rows.map((e) => {
      const base = showParent
        ? [e.name, e.sub, e.refs, e.fees, e.refs, e.paid, e.deed, e.refs ? e.deed / e.refs : 0]
        : [e.name, e.refs, e.fees, e.refs, e.paid, e.deed, e.refs ? e.deed / e.refs : 0];
      return [...base, e.partnerComm, e.agentComm] as TableRow;
    });

  const blocks: BrandedDoc['blocks'] = [
    { kind: 'section', title: 'Summary' },
    {
      kind: 'keyvalue',
      items: [
        { label: 'Referrals sent', value: a.sent, type: 'int' },
        { label: 'Referrals paid', value: a.paid, type: 'int' },
        { label: 'Deeds issued', value: a.deed, type: 'int' },
        { label: 'Conversion: Sent to Paid', value: a.sent ? a.paid / a.sent : 0, type: 'pct' },
        { label: 'Conversion: Paid to Deed', value: a.paid ? a.deed / a.paid : 0, type: 'pct' },
        { label: 'Conversion: Sent to Deed', value: a.sent ? a.deed / a.sent : 0, type: 'pct' },
        { label: 'Total guaranteed rent value', value: a.guaranteed, type: 'money' },
        { label: 'Guarantor fees collected (gross)', value: a.feesGross, type: 'money' },
        { label: `Partner commission (${pPct}% of one month rent, net of refunds)`, value: a.partnerCommNet, type: 'money' },
        { label: `Agent commission (${aPct}% of one month rent, net of refunds)`, value: a.agentCommNet, type: 'money' },
        { label: 'Average monthly rent', value: a.avgRent, type: 'money' },
        { label: 'Average guarantor fee', value: a.paid ? a.feesGross / a.paid : 0, type: 'money' },
        { label: 'Total deeds issued', value: a.deed, type: 'int' },
        { label: 'Total value of deeds issued', value: a.guaranteed, type: 'money' },
      ],
    },
    { kind: 'blank' },
    { kind: 'section', title: 'Payments and refunds (this period, live)' },
    {
      kind: 'keyvalue',
      items: [
        { label: 'Guarantor fees collected (gross)', value: a.feesGross, type: 'money' },
        { label: `Refunds (${a.refundCount})`, value: a.refundValue, type: 'money' },
        { label: 'Net fees after refunds', value: a.feesNet, type: 'money' },
        { label: `Partner commission (${pPct}%, net of refunds)`, value: a.partnerCommNet, type: 'money' },
        { label: `Agent commission (${aPct}%, net of refunds)`, value: a.agentCommNet, type: 'money' },
        { label: 'Commission excluded on refunded fees (partner + agent)', value: a.partnerCommExcl + a.agentCommExcl, type: 'money' },
      ],
    },
    { kind: 'blank' },
    { kind: 'section', title: 'Operational health' },
    {
      kind: 'keyvalue',
      items: [
        { label: 'Stuck at Sent (awaiting payment)', value: a.stuckSent, type: 'int' },
        { label: 'Stuck at Paid (awaiting deed)', value: a.stuckPaid, type: 'int' },
        { label: 'Awaiting tenant signature', value: a.awaiting, type: 'int' },
        { label: 'Awaiting signature more than 7 days', value: a.awaitingAged, type: 'int' },
        { label: 'Average days Sent to Paid', value: a.avgSentToPaidDays == null ? '—' : `${a.avgSentToPaidDays.toFixed(1)} days` },
        { label: 'Average days Paid to Deed', value: a.avgPaidToDeedDays == null ? '—' : `${a.avgPaidToDeedDays.toFixed(1)} days` },
      ],
    },
    { kind: 'blank' },
  ];
  // Per-partner commission for the period (partner + agent, gross and net). The
  // net columns sum to the summary's partner/agent commission totals.
  if (role !== 'referrer') {
    const pb = livePartnerBreakdown(role, scope, period);
    blocks.push(
      { kind: 'section', title: 'Commission by partner (this period)' },
      {
        kind: 'table',
        columns: [
          { header: 'Partner', type: 'text' },
          { header: 'Paid', type: 'int' },
          { header: 'Fees collected (gross)', type: 'money' },
          { header: 'Partner commission (gross)', type: 'money2' },
          { header: 'Partner commission (net)', type: 'money2' },
          { header: 'Agent commission (gross)', type: 'money2' },
          { header: 'Agent commission (net)', type: 'money2' },
        ],
        rows: pb.map((p) => [p.partnerName, p.paid, p.feesGross, p.partnerCommGross, p.partnerCommNet, p.agentCommGross, p.agentCommNet] as TableRow),
      },
      { kind: 'blank' },
    );
  }
  const NET_COMM: [string, string] = ['Partner commission (net)', 'Agent commission (net)'];
  const ATTR_COMM: [string, string] = ['Attributed partner commission (net)', 'Attributed agent commission (net)'];
  if (role !== 'referrer') {
    blocks.push({ kind: 'section', title: 'Breakdown by agency' }, { kind: 'table', columns: LIVE_BREAKDOWN_COLS('Agency', false, NET_COMM), rows: brk(vol.agencies, false) }, { kind: 'blank' });
  }
  blocks.push({ kind: 'section', title: 'Breakdown by branch' }, { kind: 'table', columns: LIVE_BREAKDOWN_COLS('Branch', true, NET_COMM), rows: brk(vol.branches, true) }, { kind: 'blank' });
  blocks.push(
    { kind: 'section', title: role === 'referrer' ? 'Breakdown by month' : 'Breakdown by referrer' },
    // The referrer figures are commission ATTRIBUTED to the referrals they generated
    // (partner + agent share), for insight — not a payment owed to the referrer.
    { kind: 'table', columns: LIVE_BREAKDOWN_COLS(role === 'referrer' ? 'Month' : 'Referrer', false, role === 'referrer' ? NET_COMM : ATTR_COMM), rows: brk(vol.referrers, false) },
    ...(role !== 'referrer' ? [{ kind: 'keyvalue' as const, items: [{ label: 'Note', value: 'Referrer commission columns are attribution (commission generated by each referrer’s referrals), not a payment to the referrer.' }] }] : []),
    { kind: 'blank' },
  );
  blocks.push(
    { kind: 'section', title: 'Monthly trend (last 12 months)' },
    {
      kind: 'table',
      columns: [
        { header: 'Month', type: 'text' },
        { header: 'Referrals', type: 'int' },
        { header: 'Fees collected (gross)', type: 'money' },
        { header: 'Deeds issued', type: 'int' },
      ],
      rows: liveMonths(role, scope).map((mo) => [mo.label, mo.refs, mo.fees, mo.deeds]),
    },
  );

  // Commission settlement: prior calendar month, payable on the 15th, net of refunds.
  if (role !== 'referrer') {
    const st = getCommissionSettlement(role, scope);
    const settleDay = `${st.settlementDate.getDate()}/${pad(st.settlementDate.getMonth() + 1)}/${st.settlementDate.getFullYear()}`;
    blocks.push({ kind: 'blank' }, { kind: 'section', title: `Commission settlement (${st.monthLabel}, payable ${settleDay})` });
    if (!st.partners.length) {
      blocks.push({ kind: 'keyvalue', items: [{ label: 'Payable', value: 'No partner commission accrued in the prior calendar month.' }] });
    } else {
      blocks.push({
        kind: 'keyvalue',
        // Pence throughout the settlement (money-reconciliation surface).
        items: st.partners.map((p) => ({ label: `Commission payable to ${p.partnerName}`, value: p.commission, type: 'money2' as const })),
      });
      blocks.push({
        kind: 'table',
        columns: [
          { header: 'Partner', type: 'text' },
          { header: 'Guarantee reference', type: 'text' },
          { header: 'Branch', type: 'text' },
          { header: 'Agency', type: 'text' },
          { header: 'Paid date', type: 'text' },
          { header: 'Guarantor fee', type: 'money2' },
          { header: 'Partner commission', type: 'money2' },
        ],
        rows: st.partners.flatMap((p) => p.apps.map((ap) => [p.partnerName, ap.ref, ap.branch, ap.agency, dmy(ap.paidAt), ap.rent, ap.commission] as TableRow)),
      });
    }

    // Agent commission settlement: mirrors the partner one, aggregated at agency
    // level (payable to the letting agency), prior calendar month, net of refunds.
    const ag = getAgentCommissionSettlement(role, scope);
    const agDay = `${ag.settlementDate.getDate()}/${pad(ag.settlementDate.getMonth() + 1)}/${ag.settlementDate.getFullYear()}`;
    blocks.push({ kind: 'blank' }, { kind: 'section', title: `Agent commission settlement (${ag.monthLabel}, payable ${agDay})` });
    if (!ag.agencies.length) {
      blocks.push({ kind: 'keyvalue', items: [{ label: 'Payable', value: 'No agent commission accrued in the prior calendar month.' }] });
    } else {
      blocks.push({
        kind: 'keyvalue',
        items: ag.agencies.map((a) => ({ label: `Agent commission payable to ${a.agency}`, value: a.commission, type: 'money2' as const })),
      });
      blocks.push({
        kind: 'table',
        columns: [
          { header: 'Agency', type: 'text' },
          { header: 'Partner', type: 'text' },
          { header: 'Guarantee reference', type: 'text' },
          { header: 'Branch', type: 'text' },
          { header: 'Paid date', type: 'text' },
          { header: 'Guarantor fee', type: 'money2' },
          { header: 'Agent commission', type: 'money2' },
        ],
        rows: ag.agencies.flatMap((a) => a.apps.map((ap) => [a.agency, a.partnerName, ap.ref, ap.branch, dmy(ap.paidAt), ap.rent, ap.commission] as TableRow)),
      });
    }
  }

  const [ds, de] = realPeriodRange(period);
  const metaLine = `${period.label} (${dmy(ds)} to ${dmy(de)}) · ${role === 'referrer' ? 'Your referrals only' : 'Whole estate'} · Partner: ${scopeLabel(role)} · Generated ${generatedOn()} · GBP · Live records`;
  const doc: BrandedDoc = { reportName: 'Performance export', metaLine, blocks };
  return { sheets: [{ name: 'Performance', doc }], filename: `opndoor-performance-${period.id}-${fileStamp()}.xlsx` };
}

/** Performance export: branded single-sheet .xlsx for the selected period and scope. */
export function buildPerformanceDoc(role: Role, period: Period): BrandedExport {
  if (liveAvailable()) return buildLivePerformanceDoc(role, period);
  const m = exportModel(role, period);
  const xrates = getRatesFor(scopeFor(role));
  const pPct = Math.round(xrates.partner * 100);
  const aPct = Math.round(xrates.agent * 100);
  const sB = bands(m.stuckSent, [0.55, 0.3]);
  const pB = bands(m.stuckPaid, [0.5, 0.33]);

  const blocks: BrandedDoc['blocks'] = [
    { kind: 'section', title: 'Summary' },
    {
      kind: 'keyvalue',
      items: [
        { label: 'Referrals sent', value: m.sent, type: 'int' },
        { label: 'Referrals paid', value: m.paid, type: 'int' },
        { label: 'Deeds issued', value: m.deed, type: 'int' },
        { label: 'Conversion: Sent to Paid', value: m.sent ? m.paid / m.sent : 0, type: 'pct' },
        { label: 'Conversion: Paid to Deed', value: m.paid ? m.deed / m.paid : 0, type: 'pct' },
        { label: 'Conversion: Sent to Deed', value: m.sent ? m.deed / m.sent : 0, type: 'pct' },
        { label: 'Total guaranteed rent value', value: m.deed * ANNUAL, type: 'money' },
        { label: 'Guarantor fees collected', value: m.fees, type: 'money' },
        { label: `Partner commission (${pPct}% of one month rent)`, value: m.fees * xrates.partner, type: 'money' },
        { label: `Agent commission (${aPct}% of one month rent)`, value: m.fees * xrates.agent, type: 'money' },
        { label: 'Average monthly rent', value: AVG_RENT, type: 'money' },
        { label: 'Average guarantor fee', value: m.paid ? m.fees / m.paid : 0, type: 'money' },
        { label: 'Total deeds issued', value: m.deed, type: 'int' },
        { label: 'Total value of deeds issued', value: m.deed * ANNUAL, type: 'money' },
      ],
    },
    { kind: 'blank' },
    { kind: 'section', title: 'Stuck applications by age band' },
    {
      kind: 'table',
      columns: [
        { header: 'Stage', type: 'text' },
        { header: '7 to 14 days', type: 'int' },
        { header: '14 to 30 days', type: 'int' },
        { header: '30+ days', type: 'int' },
        { header: 'Total', type: 'int' },
      ],
      rows: [
        ['Stuck at Sent (awaiting payment)', sB[0], sB[1], sB[2], m.stuckSent],
        ['Stuck at Paid (awaiting deed)', pB[0], pB[1], pB[2], m.stuckPaid],
      ],
    },
    { kind: 'blank' },
  ];

  // (Live payment/refund figures are produced by buildLivePerformanceDoc; this
  // synthetic path is only reached in mock/test mode.)

  if (role !== 'referrer') {
    blocks.push({ kind: 'section', title: 'Breakdown by agency' }, { kind: 'table', columns: BREAKDOWN_COLS('Agency', false), rows: breakdownRows(m.agencies, false) }, { kind: 'blank' });
  }
  blocks.push({ kind: 'section', title: 'Breakdown by branch' }, { kind: 'table', columns: BREAKDOWN_COLS('Branch', true), rows: breakdownRows(m.branches, true) }, { kind: 'blank' });
  blocks.push(
    { kind: 'section', title: role === 'referrer' ? 'Breakdown by month' : 'Breakdown by referrer' },
    { kind: 'table', columns: BREAKDOWN_COLS(role === 'referrer' ? 'Month' : 'Referrer', false), rows: breakdownRows(m.referrers, false) },
    { kind: 'blank' },
  );
  blocks.push(
    { kind: 'section', title: 'Monthly trend (last 12 months)' },
    {
      kind: 'table',
      columns: [
        { header: 'Month', type: 'text' },
        { header: 'Referrals', type: 'int' },
        { header: 'Fees collected', type: 'money' },
        { header: 'Deeds issued', type: 'int' },
      ],
      rows: TREND_MONTHS.map((t) => {
        const paid = Math.round(t[1] * 0.78);
        return [t[0], t[1], paid * AVG_RENT, Math.round(paid * 0.9)];
      }),
    },
  );

  const doc: BrandedDoc = {
    reportName: 'Performance export',
    metaLine: brandMeta(period, role === 'referrer' ? 'Your referrals only' : 'Whole estate', scopeLabel(role)),
    blocks,
  };
  return { sheets: [{ name: 'Performance', doc }], filename: `opndoor-performance-${period.id}-${fileStamp()}.xlsx` };
}

/** What the dashboard period filters the application export on. */
export type ExportBasis = 'referred' | 'paid' | 'deed' | 'activity';

export const BASIS_META: Record<ExportBasis, { label: string; recon: string; hint: string }> = {
  referred: { label: 'by referral sent date', recon: 'equals Referrals sent in the performance export for this period', hint: 'Applications first referred (Sent) within the period. Status shown is the latest state now, so payments and deeds that happened later still appear.' },
  paid: { label: 'by payment date', recon: 'equals the referrals Paid in this period (reconciles to fees collected)', hint: 'Applications whose guarantor fee was paid within the period, whenever they were referred. Use this to reconcile fees and commission each month.' },
  deed: { label: 'by deed issue date', recon: 'equals the Deeds issued in this period', hint: 'Applications whose Deed of Guarantee was issued within the period, whenever they were referred.' },
  activity: { label: 'by any event in the period', recon: 'every application with a Sent, Paid or Deed Issued event in this period', hint: 'Everything that moved in the period: any application Sent, Paid or Deed issued within it, including referrals from earlier months that paid or issued now. An "Activity in period" column lists which events fell in the period.' },
};

interface SynthApp {
  ref: string;
  agency: string;
  branch: string;
  referrer: string;
  status: 'sent' | 'paid' | 'deed';
  sent: Date;
  paid: Date | null;
  deed: Date | null;
  rent: number;
  tStart: Date;
  expiry: Date | null;
  events?: string[];
}

/**
 * Synthesise application rows on one of four bases so the row count reconciles
 * to the matching funnel figure (referred -> Sent, paid -> Paid, deed -> Deeds;
 * activity -> anything that moved in the window).
 */
function generateApplications(period: Period, basis: ExportBasis): SynthApp[] {
  const [start, end] = periodRange(period);
  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY));
  const inWin = (x: Date | null): boolean => !!x && x >= start && x <= end;
  const withEvents = (a: SynthApp): SynthApp => {
    const ev: string[] = [];
    if (inWin(a.sent)) ev.push('Sent');
    if (inWin(a.paid)) ev.push('Paid');
    if (inWin(a.deed)) ev.push('Deed Issued');
    a.events = ev;
    return a;
  };
  const mk = (i: number, refBase: number, o: { status: SynthApp['status']; sent: Date; paid: Date | null; deed: Date | null }): SynthApp => {
    const b = APP_BRANCHES[i % APP_BRANCHES.length];
    const rent = APP_RENTS[(i * 7) % APP_RENTS.length];
    const tStart = addDays(o.sent, 14 + (i % 10));
    const expiry = o.deed ? guaranteeExpiry(tStart) : null;
    return withEvents({ ref: `GR-${refBase + i}`, agency: b[1], branch: b[0], referrer: APP_REFERRERS[(i * 3) % APP_REFERRERS.length], status: o.status, sent: o.sent, paid: o.paid, deed: o.deed, rent, tStart, expiry });
  };

  if (basis === 'activity') {
    const apps: SynthApp[] = [];
    const sentN = period.fSent;
    const paidInWin = Math.round(sentN * period.sp);
    const deedInWin = Math.round(paidInWin * period.pd);
    // 1) referred in period (latest status)
    const paidOfCohort = Math.round(sentN * period.sp);
    const deedOfCohort = Math.round(paidOfCohort * period.pd);
    for (let i = 0; i < sentN; i++) {
      const st: SynthApp['status'] = i < deedOfCohort ? 'deed' : i < paidOfCohort ? 'paid' : 'sent';
      const s1 = addDays(start, Math.floor(((i + 0.5) / sentN) * spanDays));
      const p1 = st !== 'sent' ? addDays(s1, 3 + (i % 5)) : null;
      const d1 = st === 'deed' && p1 ? addDays(p1, 1 + (i % 3)) : null;
      apps.push(mk(i, 31000, { status: st, sent: s1, paid: p1, deed: d1 }));
    }
    // 2) carried in from earlier months, paid this period (not deed yet)
    const carriedPaid = Math.round(paidInWin * 0.35);
    for (let i = 0; i < carriedPaid; i++) {
      const p2 = addDays(start, Math.floor(((i + 0.5) / Math.max(1, carriedPaid)) * spanDays));
      apps.push(mk(i, 34000, { status: 'paid', sent: addDays(p2, -(24 + (i % 20))), paid: p2, deed: null }));
    }
    // 3) carried in from earlier months, deed issued this period
    const carriedDeed = Math.round(deedInWin * 0.3);
    for (let i = 0; i < carriedDeed; i++) {
      const d3 = addDays(start, Math.floor(((i + 0.5) / Math.max(1, carriedDeed)) * spanDays));
      const p3 = addDays(d3, -(2 + (i % 4)));
      const s3 = addDays(p3, -(26 + (i % 18)));
      apps.push(mk(i, 37000, { status: 'deed', sent: s3, paid: p3, deed: d3 }));
    }
    return apps.filter((a) => a.events && a.events.length);
  }

  const N = basis === 'paid' ? Math.round(period.fSent * period.sp) : basis === 'deed' ? Math.round(period.fSent * period.sp * period.pd) : period.fSent;
  const apps: SynthApp[] = [];
  for (let i = 0; i < N; i++) {
    const payLag = 3 + (i % 5);
    const deedLag = 1 + (i % 3);
    let sent: Date;
    let paid: Date | null;
    let deed: Date | null;
    let status: SynthApp['status'];
    if (basis === 'paid') {
      paid = addDays(start, Math.floor(((i + 0.5) / N) * spanDays));
      sent = addDays(paid, -payLag);
      const hasDeed = i < Math.round(N * period.pd);
      deed = hasDeed ? addDays(paid, deedLag) : null;
      status = hasDeed ? 'deed' : 'paid';
    } else if (basis === 'deed') {
      deed = addDays(start, Math.floor(((i + 0.5) / N) * spanDays));
      paid = addDays(deed, -deedLag);
      sent = addDays(paid, -payLag);
      status = 'deed';
    } else {
      const paidN = Math.round(N * period.sp);
      const deedN = Math.round(paidN * period.pd);
      status = i < deedN ? 'deed' : i < paidN ? 'paid' : 'sent';
      sent = addDays(start, Math.floor(((i + 0.5) / N) * spanDays));
      paid = status !== 'sent' ? addDays(sent, payLag) : null;
      deed = status === 'deed' && paid ? addDays(paid, deedLag) : null;
    }
    const b = APP_BRANCHES[i % APP_BRANCHES.length];
    const rent = APP_RENTS[(i * 7) % APP_RENTS.length];
    const tStart = addDays(sent, 14 + (i % 10));
    const expiry = deed ? guaranteeExpiry(tStart) : null;
    apps.push({ ref: `GR-${31000 + i}`, agency: b[1], branch: b[0], referrer: APP_REFERRERS[(i * 3) % APP_REFERRERS.length], status, sent, paid, deed, rent, tStart, expiry });
  }
  return apps;
}

/** Application export from live records (Supabase mode), with refund columns. */
function buildRealApplicationDoc(role: Role, period: Period, basis: ExportBasis, meta: { label: string; recon: string; hint: string }): BrandedExport {
  const [start, end] = realPeriodRange(period);
  const apps = scopeFull(allFull(), role, scopeFor(role)).filter((a) => basisInPeriod(a, basis, start, end));
  const STATUS: Record<FullApp['status'], string> = { sent: 'Sent', paid: 'Paid', deed: 'Deed Issued' };

  const columns: Column[] = [
    { header: 'Partner', type: 'text' },
    { header: 'Guarantee reference', type: 'text' },
    { header: 'Agency', type: 'text' },
    { header: 'Branch', type: 'text' },
    { header: 'Referrer', type: 'text' },
    { header: 'Status', type: 'text' },
    { header: 'Payment state', type: 'text' },
    { header: 'Sent date', type: 'text' },
    { header: 'Paid date', type: 'text' },
    { header: 'Deed issued date', type: 'text' },
    { header: 'Refund date', type: 'text' },
    { header: 'Refund amount', type: 'text' },
    { header: 'Monthly rent', type: 'money' },
    { header: 'Guarantor fee', type: 'money' },
    { header: 'Partner commission', type: 'money' },
    { header: 'Agent commission', type: 'money' },
    { header: 'Tenancy start date', type: 'text' },
    { header: 'Expiry date', type: 'text' },
    { header: 'Refund policy anomaly', type: 'text' },
  ];
  if (basis === 'activity') columns.push({ header: 'Activity in period', type: 'text' });

  const rows: TableRow[] = apps.map((a) => {
    const ev: string[] = [];
    if (inRange(a.sentAt, start, end)) ev.push('Sent');
    if (inRange(a.paidAt, start, end)) ev.push('Paid');
    if (inRange(a.deedAt, start, end)) ev.push('Deed Issued');
    const payState = a.refunded ? 'Refunded' : a.paidAt ? 'Paid' : 'Awaiting payment';
    const rates = getRatesFor(a.partner);
    const partnerComm = a.refunded ? 0 : a.rent * rates.partner;
    const agentComm = a.refunded ? 0 : a.rent * rates.agent;
    const row: TableRow = [
      partnerName(a.partner), a.ref, a.agency, a.branch, a.referrer, STATUS[a.status], payState,
      a.sentAt ? dmy(a.sentAt) : '', a.paidAt ? dmy(a.paidAt) : '', a.deedAt ? dmy(a.deedAt) : '',
      a.refundedAt ? dmy(a.refundedAt) : '', a.refundedAmount != null ? gbp(a.refundedAmount) : '',
      a.rent, a.rent, partnerComm, agentComm,
      a.tenancyStart ? dmy(a.tenancyStart) : '', a.expiry ? dmy(a.expiry) : '',
      a.refundAfterStart ? 'Yes - refunded after tenancy start' : '',
    ];
    if (basis === 'activity') row.push(ev.join(', '));
    return row;
  });

  const metaLine = `${period.label} (${dmy(start)} to ${dmy(end)}) · Whole estate (${meta.label}) · Partner: ${scopeLabel(role)} · Generated ${generatedOn()} · GBP`;
  const doc: BrandedDoc = {
    reportName: 'Application export',
    metaLine,
    blocks: [
      {
        kind: 'keyvalue',
        items: [
          { label: 'Basis', value: `Filtered ${meta.label}` },
          { label: 'Applications', value: `${apps.length} live records` },
          { label: 'Note', value: 'Live records, pseudonymised by guarantee reference. Payment state, refund date and refund amount are included. A refund does not reverse a Paid application.' },
        ],
      },
      { kind: 'blank' },
      { kind: 'table', columns, rows },
    ],
  };
  return { sheets: [{ name: 'Applications', doc }], filename: `opndoor-applications-${basis}-${period.id}-${fileStamp()}.xlsx` };
}

/**
 * Application-level (pseudonymised) export on the chosen basis, as a branded
 * .xlsx. Blocked for referrers. The four-basis selection is unchanged.
 */
export function buildApplicationDoc(role: Role, period: Period, basis: ExportBasis = 'referred'): BrandedExport | null {
  if (role === 'referrer') return null; // never for referrers
  const meta = BASIS_META[basis];
  if (SUPABASE_ENABLED && allFull().length) return buildRealApplicationDoc(role, period, basis, meta);
  const apps = generateApplications(period, basis);
  const STATUS: Record<SynthApp['status'], string> = { sent: 'Sent', paid: 'Paid', deed: 'Deed Issued' };

  const columns: Column[] = [
    { header: 'Guarantee reference', type: 'text' },
    { header: 'Agency', type: 'text' },
    { header: 'Branch', type: 'text' },
    { header: 'Referrer', type: 'text' },
    { header: 'Status', type: 'text' },
    { header: 'Sent date', type: 'text' },
    { header: 'Paid date', type: 'text' },
    { header: 'Deed issued date', type: 'text' },
    { header: 'Monthly rent', type: 'money' },
    { header: 'Guarantor fee', type: 'money' },
    { header: 'Tenancy start date', type: 'text' },
    { header: 'Expiry date', type: 'text' },
  ];
  if (basis === 'activity') columns.push({ header: 'Activity in period', type: 'text' });

  const rows: TableRow[] = apps.map((a) => {
    const row: TableRow = [a.ref, a.agency, a.branch, a.referrer, STATUS[a.status], dmy(a.sent), a.paid ? dmy(a.paid) : '', a.deed ? dmy(a.deed) : '', a.rent, a.rent, dmy(a.tStart), a.expiry ? dmy(a.expiry) : ''];
    if (basis === 'activity') row.push((a.events || []).join(', '));
    return row;
  });

  const doc: BrandedDoc = {
    reportName: 'Application export',
    metaLine: brandMeta(period, `Whole estate (${meta.label})`, scopeLabel(role)),
    blocks: [
      {
        kind: 'keyvalue',
        items: [
          { label: 'Basis', value: `Filtered ${meta.label}` },
          { label: 'Applications', value: `${apps.length} (${meta.recon})` },
          { label: 'Note', value: 'Pseudonymised by guarantee reference. No tenant names or contact details are included. Status is the latest state; paid and deed dates are shown whenever they occurred.' },
        ],
      },
      { kind: 'blank' },
      { kind: 'table', columns, rows },
    ],
  };
  return { sheets: [{ name: 'Applications', doc }], filename: `opndoor-applications-${basis}-${period.id}-${fileStamp()}.xlsx` };
}

/* ---- League export: three branded sheets (Agencies, Branches, Referrers) ---- */
function leaguePartnerLabel(scope: PartnerScope, partner: string): string {
  if (scope !== ALL_PARTNERS) return partnerName(scope);
  if (partner) return partnerName(partner);
  return 'All partners (combined)';
}
function leagueColumns(view: LeagueView): Column[] {
  const first: Column = { header: view === 'agency' ? 'Agency' : view === 'branch' ? 'Branch' : 'Referrer', type: 'text' };
  const core: Column[] = [
    { header: 'Referrals', type: 'int' },
    { header: 'Fees collected', type: 'money' },
    { header: 'Paid', type: 'int' },
    { header: 'Deeds', type: 'int' },
    { header: 'Sent to Paid', type: 'pct' },
    { header: 'Sent to Deed', type: 'pct' },
  ];
  if (view === 'referrer') return [first, ...core];
  return [first, { header: 'Detail', type: 'text' }, ...core, { header: 'Partner commission', type: 'money' }, { header: 'Agent commission', type: 'money' }];
}
function leagueRows(view: LeagueView, rows: LeagueRow[]): TableRow[] {
  return rows.map((r) =>
    view === 'referrer'
      ? [r.name, r.refs, r.fees, r.paid, r.deed, r.sp, r.conv]
      : [r.name, r.sub, r.refs, r.fees, r.paid, r.deed, r.sp, r.conv, r.partnerComm, r.agentComm],
  );
}

/**
 * League export: a branded three-sheet workbook (Agencies, Branches,
 * Referrers), respecting role + partner scoping. In live (Supabase) mode the
 * tables are period-filtered by real dates (same as the on-screen league); in
 * mock mode the league is the modelled current book. The metadata date range
 * reflects the actual window filtered.
 */
export function buildLeagueDoc(role: Role, scope: PartnerScope, partner: string, period: Period): BrandedExport {
  const views: { view: LeagueView; name: string }[] = [
    { view: 'agency', name: 'Agencies' },
    { view: 'branch', name: 'Branches' },
    { view: 'referrer', name: 'Referrers' },
  ];
  const scopeText = role === 'referrer' ? 'Your slice' : 'Whole estate';
  const partnerLabel = leaguePartnerLabel(scope, partner);
  let metaLine: string;
  if (liveAvailable()) {
    const [ds, de] = realPeriodRange(period);
    metaLine = `${period.label} (${dmy(ds)} to ${dmy(de)}) · ${scopeText} · Partner: ${partnerLabel} · Generated ${generatedOn()} · GBP · Live records`;
  } else {
    metaLine = brandMeta(period, scopeText, partnerLabel);
  }
  const sheets = views.map(({ view, name }) => ({
    name,
    doc: {
      reportName: `League table: ${name}`,
      metaLine,
      blocks: [{ kind: 'table', columns: leagueColumns(view), rows: leagueRows(view, getLeague(view, { role, scope, partner, period })) }],
    } as BrandedDoc,
  }));
  return { sheets, filename: `opndoor-league-${fileStamp()}.xlsx` };
}

function bxIssuedCount(y: number, m0: number): number {
  const seed = y * 12 + m0;
  return 58 + ((seed * 37) % 53);
}

/** Live bordereau: real applications whose TENANCY START falls in the month,
    Deed Issued, excluding refunded. Format and columns are frozen identical to
    the synthetic version; only the row source changes. Whole opndoor book. */
export function buildLiveBordereau(year: number, m0: number, insuranceRate: number): { csv: string; filename: string } {
  const ratePct = `${insuranceRate}%`;
  const mStart = new Date(year, m0, 1, 0, 0, 0, 0);
  const mEnd = new Date(year, m0 + 1, 0, 23, 59, 59, 999);
  const dobDmy = (iso: string | null | undefined): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  // Tenancies commencing in month M, Deed Issued, not refunded (per the rule).
  const apps = allFull()
    .filter((a) => a.status === 'deed' && !a.refunded && a.tenancyStart && a.tenancyStart >= mStart && a.tenancyStart <= mEnd)
    .sort((x, y) => (x.tenancyStart!.getTime() - y.tenancyStart!.getTime()) || x.ref.localeCompare(y.ref));

  const rows: CsvRow[] = [];
  rows.push(['opndoor Guarantee Referral Portal — underwriter bordereau (C&C format)']);
  rows.push(['Generated', new Date().toLocaleString('en-GB')]);
  rows.push(['Month', `${MONTH_NAMES[m0]} ${year} (by tenancy commencement date)`]);
  rows.push(['Scope', 'All partners (opndoor whole book). Partner shown per row.']);
  rows.push(['Guarantees issued', apps.length]);
  rows.push(['Insurance rate applied', ratePct]);
  rows.push(['Currency', 'GBP']);
  rows.push(['Confidential', 'Contains full tenant personal data. For the underwriter only.']);
  rows.push([]);
  rows.push(['Partner', 'Guarantee Reference', 'Tenant Title', 'First Name', 'Last Name', 'DOB', 'Tenant Role', 'Property Address 1', 'Property Address 2', 'City/Town', 'County', 'Postcode', 'Claim Contact (Agent)', 'Issue Date', 'Tenancy Date', 'Guarantee Expiry', 'Monthly Rent', 'Insurance %', 'Status']);
  for (const a of apps) {
    const rec = findRecord(a.ref);
    // Claim Contact (Agent): the resolved agent email, else the agency name so the
    // required column is never blank (matches the synthetic column).
    const claimContact = contactForApplication(a.agency, a.branch).contact?.email || a.agency;
    const first = rec?.firstName ?? (rec?.name ? rec.name.split(/\s+/).slice(0, -1).join(' ') : '');
    const last = rec?.lastName ?? (rec?.name ? rec.name.split(/\s+/).slice(-1).join(' ') : '');
    const expiry = a.expiry ?? (a.tenancyStart ? guaranteeExpiry(a.tenancyStart) : null);
    rows.push([
      partnerName(a.partner), a.ref, rec?.title ?? '', first, last,
      dobDmy(rec?.dob), 'Tenant', rec?.addr1 ?? '', rec?.addr2 ?? '', rec?.city ?? '', rec?.county ?? '', rec?.postcode ?? '', claimContact,
      a.deedAt ? dmy(a.deedAt) : '', a.tenancyStart ? dmy(a.tenancyStart) : '', expiry ? dmy(expiry) : '', gbp(a.rent), ratePct, 'Deed Issued',
    ]);
  }
  return { csv: toCSV(rows), filename: `opndoor-bordereau-${year}-${pad(m0 + 1)}.csv` };
}

/**
 * Monthly underwriter bordereau (C&C format). opndoor-admin only; full tenant PII.
 * Buckets by TENANCY START DATE: tenancies commencing in month M are reported to
 * C&C by the 15th of M+1. Deed Issued only, refunded guarantees excluded (a
 * refunded guarantee carries no risk and owes no premium). Live-sourced in
 * Supabase mode; the modelled generator remains for mock/test.
 *
 * INTEGRATION: mid-period reversals - a guarantee already on a submitted month's
 * bordereau, then refunded afterwards - are handled as a CORRECTION on the
 * following month's return (the refunded guarantee simply drops out; whether the
 * correction is a removal or an explicit negative line is a convention pending
 * C&C confirmation). It is not invented here; flagged for review.
 */
export function buildBordereauCsv(role: Role, year: number, m0: number, insuranceRate: number): { csv: string; filename: string } | null {
  if (role !== 'superadmin') return null; // strictly gated: blocked even if triggered
  if (liveAvailable()) return buildLiveBordereau(year, m0, insuranceRate);
  const ratePct = `${insuranceRate}%`;
  const N = bxIssuedCount(year, m0);
  const daysInMonth = new Date(year, m0 + 1, 0).getDate();
  const rows: CsvRow[] = [];
  rows.push(['opndoor Guarantee Referral Portal — underwriter bordereau (C&C format)']);
  rows.push(['Generated', new Date().toLocaleString('en-GB')]);
  rows.push(['Month', `${MONTH_NAMES[m0]} ${year} (by tenancy commencement date)`]);
  rows.push(['Scope', 'All partners (opndoor whole book). Partner shown per row.']);
  rows.push(['Guarantees issued', N]);
  rows.push(['Insurance rate applied', ratePct]);
  rows.push(['Currency', 'GBP']);
  rows.push(['Confidential', 'Contains full tenant personal data. For the underwriter only.']);
  rows.push([]);
  rows.push(['Partner', 'Guarantee Reference', 'Tenant Title', 'First Name', 'Last Name', 'DOB', 'Tenant Role', 'Property Address 1', 'Property Address 2', 'City/Town', 'County', 'Postcode', 'Claim Contact (Agent)', 'Issue Date', 'Tenancy Date', 'Guarantee Expiry', 'Monthly Rent', 'Insurance %', 'Status']);
  for (let i = 0; i < N; i++) {
    // Bucket by TENANCY START in month M (matches the live path); the deed is
    // issued shortly before the tenancy commences.
    const tenancyDay = 1 + Math.floor((i / N) * (daysInMonth - 1));
    const tenancy = new Date(year, m0, tenancyDay);
    const issue = addDays(tenancy, -(4 + (i % 14)));
    // Guarantee Expiry is the tenancy date + 12 months - 1 day (one shared rule).
    const expiry = guaranteeExpiry(tenancy);
    const dobYear = 1990 + ((i * 5) % 16);
    const dob = new Date(dobYear, (i * 7) % 12, ((i * 11) % 27) + 1);
    const st = BX_STREETS[(i * 3) % BX_STREETS.length];
    const b = APP_BRANCHES[i % APP_BRANCHES.length];
    const refNo = 40000 + (year * 12 + m0) * 200 + i;
    const partner = i % 7 === 0 ? 'Zoopla' : i % 11 === 0 ? 'OnTheMarket' : 'Rightmove';
    const flat = BX_FLATS[i % BX_FLATS.length];
    rows.push([
      partner, `GR-${refNo}`, BX_TITLES[i % BX_TITLES.length], BX_FIRST[(i * 5) % BX_FIRST.length], BX_LAST[(i * 3) % BX_LAST.length],
      dmy(dob), 'Tenant', (flat ? `${flat}, ` : '') + st[0], '', 'London', 'Greater London', st[1], b[1],
      dmy(issue), dmy(tenancy), dmy(expiry), gbp(APP_RENTS[(i * 7) % APP_RENTS.length]), ratePct, 'Deed Issued',
    ]);
  }
  return { csv: toCSV(rows), filename: `opndoor-bordereau-${year}-${pad(m0 + 1)}.csv` };
}
