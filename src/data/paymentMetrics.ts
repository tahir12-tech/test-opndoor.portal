/* =====================================================================
   Real payment + refund metrics, computed from the live full-application set
   (Supabase mode). The dashboard funnel and volume charts remain the modelled
   portfolio view; these figures are the live payment truth, so refunds are
   honest and reported alongside without touching paid/conversion.

   In mock/test mode getPaymentSummary reports available = false and the UI
   simply does not show the live-payments block.
   ===================================================================== */
import { SUPABASE_ENABLED } from '@/lib/supabase';
import type { PartnerScope, Period, Role } from './types';
import { ALL_PARTNERS } from './types';
import { allFull, type FullApp } from './applicationsService';

/** Period date range. Real "today" in Supabase mode; the demo date otherwise. */
export function periodRange(period: Period): [Date, Date] {
  const now = SUPABASE_ENABLED ? new Date() : new Date(2026, 5, 26);
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const s = (yy: number, mm: number, dd: number) => new Date(yy, mm, dd, 0, 0, 0, 0);
  const e = (yy: number, mm: number, dd: number) => new Date(yy, mm, dd, 23, 59, 59, 999);
  switch (period.id) {
    case 'thismonth': return [s(y, m, 1), e(y, m + 1, 0)];
    case 'lastmonth': return [s(y, m - 1, 1), e(y, m, 0)];
    case 'last7': return [s(y, m, d - 6), e(y, m, d)];
    case 'last30': return [s(y, m, d - 29), e(y, m, d)];
    case 'last90': return [s(y, m, d - 89), e(y, m, d)];
    case 'last12m': return [s(y - 1, m, d), e(y, m, d)];
    default: return [s(2024, 8, 1), e(y, m, d)]; // all time, from 2024-09
  }
}

/** Role + partner isolation, matching the applications list rule. */
export function scopeFull(apps: FullApp[], role: Role, scope: PartnerScope): FullApp[] {
  let set = apps;
  if (scope !== ALL_PARTNERS) set = set.filter((a) => a.partner === scope);
  if (role === 'referrer') set = set.filter((a) => a.owner === 1);
  return set;
}

export function inRange(x: Date | null, start: Date, end: Date): boolean {
  return !!x && x >= start && x <= end;
}

export type ExportBasisKind = 'referred' | 'paid' | 'deed' | 'activity';

/** Whether an application falls in the period on the chosen export basis. */
export function basisInPeriod(a: FullApp, basis: ExportBasisKind, start: Date, end: Date): boolean {
  if (basis === 'referred') return inRange(a.sentAt, start, end);
  if (basis === 'paid') return inRange(a.paidAt, start, end);
  if (basis === 'deed') return inRange(a.deedAt, start, end);
  return inRange(a.sentAt, start, end) || inRange(a.paidAt, start, end) || inRange(a.deedAt, start, end);
}

export interface PaymentSummary {
  available: boolean;
  paidInPeriod: number;
  feesGross: number;
  refundCount: number;
  refundValue: number;
  feesNet: number;
}

/** Live fees collected (gross), refunds (count + value) and net, for the period. */
export function getPaymentSummary(role: Role, scope: PartnerScope, period: Period): PaymentSummary {
  if (!SUPABASE_ENABLED || allFull().length === 0) {
    return { available: false, paidInPeriod: 0, feesGross: 0, refundCount: 0, refundValue: 0, feesNet: 0 };
  }
  const [start, end] = periodRange(period);
  const set = scopeFull(allFull(), role, scope);
  let paidInPeriod = 0;
  let feesGross = 0;
  let refundCount = 0;
  let refundValue = 0;
  for (const a of set) {
    if (inRange(a.paidAt, start, end)) { paidInPeriod += 1; feesGross += a.rent; }
    if (inRange(a.refundedAt, start, end)) { refundCount += 1; refundValue += a.refundedAmount ?? a.rent; }
  }
  return { available: true, paidInPeriod, feesGross, refundCount, refundValue, feesNet: feesGross - refundValue };
}

export interface AwaitingSignature {
  ref: string;
  branch: string;
  agency: string;
  sentAt: Date;
  /** When the tenant first opened the deed (null = not yet viewed). */
  viewedAt: Date | null;
  days: number;
}

/**
 * Deeds sent to the tenant for e-signature and still unsigned after the ageing
 * threshold (default 7 days). Live (Supabase) only; empty in mock/test mode.
 */
export function getAwaitingSignature(role: Role, scope: PartnerScope, thresholdDays = 7): AwaitingSignature[] {
  if (!SUPABASE_ENABLED || allFull().length === 0) return [];
  const now = new Date();
  const set = scopeFull(allFull(), role, scope);
  const out: AwaitingSignature[] = [];
  for (const a of set) {
    if (a.deedState !== 'awaiting_tenant' || !a.deedSentAt) continue;
    const days = Math.floor((now.getTime() - a.deedSentAt.getTime()) / 86_400_000);
    if (days > thresholdDays) out.push({ ref: a.ref, branch: a.branch, agency: a.agency, sentAt: a.deedSentAt, viewedAt: a.deedViewedAt, days });
  }
  return out.sort((x, y) => y.days - x.days);
}
