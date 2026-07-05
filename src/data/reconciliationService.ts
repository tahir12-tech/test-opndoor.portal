/* =====================================================================
   Reconciliation service (opndoor admin only).
   The real queue of agencies/branches created on the fly by referrers
   (review_state = pending_review), each with its parent, creator, created-at,
   attached referral count, and a same/similar-name hint against confirmed
   records. "Confirm as new" promotes it to confirmed (audited). Merge and
   HubSpot sync are not built yet.

   Live mode uses the reconciliation_queue / confirm_org_entity RPCs; the badge
   count is derived synchronously from the hydrated org (pending entities).
   Mock/test mode keeps an in-memory demo queue.
   ===================================================================== */
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';
import { getAgencies } from './orgService';
import { ALL_PARTNERS } from './types';

export interface ReconRow {
  /** Composite key `${type}:${entityId}` for React lists. */
  id: string;
  entityId: string;
  type: 'agency' | 'branch';
  name: string;
  parent: string | null;
  by: string;
  when: string;
  refs: number;
  /** Name of a confirmed record this looks like, or null. */
  match: string | null;
  /** True when the match is an exact (case-insensitive) same-name hit. */
  matchExact: boolean;
}

function fmtWhen(ts: string): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} · ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Mock/demo queue (mock mode only). Illustrative pending entities.
const MOCK_QUEUE: ReconRow[] = [
  { id: 'branch:m1', entityId: 'm1', type: 'branch', name: 'Sth Kensington', parent: 'Foxglove Residential', by: 'James Okafor', when: '18/06/2026 · 14:22', refs: 1, match: 'South Kensington', matchExact: false },
  { id: 'agency:m2', entityId: 'm2', type: 'agency', name: 'Marylebone and Co.', parent: null, by: 'Aisha Khan', when: '17/06/2026 · 09:48', refs: 2, match: 'Marylebone & Co', matchExact: false },
  { id: 'branch:m3', entityId: 'm3', type: 'branch', name: 'Wandsworth', parent: 'Hartwell Estates', by: 'Marcus Lin', when: '16/06/2026 · 16:05', refs: 3, match: null, matchExact: false },
  { id: 'agency:m4', entityId: 'm4', type: 'agency', name: 'Camden Town Lettings', parent: null, by: 'Daniel Wright', when: '13/06/2026 · 10:12', refs: 1, match: null, matchExact: false },
  // #96 A single-office fly-created agency plus its auto "[Agency], Head office"
  // branch: confirming the agency should sweep this branch in the same action.
  { id: 'agency:m5', entityId: 'm5', type: 'agency', name: 'Bracken & Vale', parent: null, by: 'Priya Nair', when: '12/06/2026 · 11:30', refs: 1, match: null, matchExact: false },
  { id: 'branch:m6', entityId: 'm6', type: 'branch', name: 'Bracken & Vale, Head office', parent: 'Bracken & Vale', by: 'Priya Nair', when: '12/06/2026 · 11:30', refs: 1, match: null, matchExact: false },
];

/** The pending-review queue (admin only). Async: live RPC or the mock queue. */
export async function loadReconciliationQueue(): Promise<ReconRow[]> {
  if (SUPABASE_ENABLED) {
    const { data, error } = await sb().rpc('reconciliation_queue');
    if (error) throw new Error(error.message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((r: any) => ({
      id: `${r.entity_type}:${r.entity_id}`,
      entityId: r.entity_id,
      type: r.entity_type,
      name: r.name,
      parent: r.parent ?? null,
      by: r.created_by_name ?? 'A referrer',
      when: r.created_at ? fmtWhen(r.created_at) : '',
      refs: Number(r.referral_count ?? 0),
      match: r.match_name ?? null,
      matchExact: !!r.match_exact,
    }));
  }
  return MOCK_QUEUE.slice();
}

/** Confirm a pending entity as a new canonical record (audited). */
export async function confirmReconEntity(type: 'agency' | 'branch', entityId: string): Promise<void> {
  if (SUPABASE_ENABLED) {
    const { error } = await sb().rpc('confirm_org_entity', { p_type: type, p_id: entityId });
    if (error) throw new Error(error.message);
    return;
  }
  const i = MOCK_QUEUE.findIndex((r) => r.entityId === entityId);
  if (i < 0) return;
  const row = MOCK_QUEUE[i];
  MOCK_QUEUE.splice(i, 1);
  // #96 Confirming an agency also sweeps its auto-created "[Agency], Head office" branch.
  if (row.type === 'agency') {
    const ho = `${row.name}, Head office`.toLowerCase();
    const bi = MOCK_QUEUE.findIndex((r) => r.type === 'branch' && r.parent === row.name && r.name.toLowerCase() === ho);
    if (bi >= 0) MOCK_QUEUE.splice(bi, 1);
  }
}

/** Pending count for the sidebar badge. Derived synchronously from the hydrated
    org in live mode (admins hydrate every agency/branch), or the demo queue. */
export function reconciliationPendingCount(): number {
  if (SUPABASE_ENABLED) {
    let n = 0;
    for (const a of getAgencies(ALL_PARTNERS)) {
      if (a.unreviewed) n += 1;
      n += (a.branches || []).filter((b) => b.unreviewed).length;
    }
    return n;
  }
  return MOCK_QUEUE.length;
}
