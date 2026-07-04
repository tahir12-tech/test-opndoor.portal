/* =====================================================================
   Partner service — the multi-partner model.
   Resolves partner scope centrally: opndoor admin uses a selected partner
   (which may be "all"); Management and Referrer are pinned to their home
   partner. Commission rates are per-partner and read from the partner
   record — never hard-coded.

   INTEGRATION: getPartners/addPartner/updatePartner map to
   GET/POST/PATCH /partners. getSelected/setSelected stay client-side
   (a UI preference). scopeFor mirrors the server's partner-isolation rule.
   ===================================================================== */
import type { CommissionRates, Partner, PartnerScope, PartnerStatus, Role } from './types';
import { ALL_PARTNERS } from './types';
import { KEYS, clone, loadJSON, loadString, saveJSON, saveString } from './storage';
import { DEFAULT_AGENT_RATE, DEFAULT_PARTNER_RATE, HOME_PARTNER, PARTNERS_SEED } from './mock/partners';
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';

// Working copy, seeded from localStorage or the seed. The only place the list lives.
let PARTNERS: Partner[] = loadJSON<Partner[]>(KEYS.partners, clone(PARTNERS_SEED));
if (!PARTNERS.length) PARTNERS = clone(PARTNERS_SEED);

// The signed-in user's home partner. Defaults to the demo home partner; set from
// the real session profile in Supabase mode (see SessionContext / hydrate).
let HOME: string = HOME_PARTNER;

function persist(): void {
  saveJSON(KEYS.partners, PARTNERS);
}

/** Replace the partner list from the back end (Supabase mode). */
export function hydratePartners(rows: Partner[]): void {
  PARTNERS = rows.slice();
}

/** Set the signed-in user's home partner (Management/Referrer scope). */
export function setHomePartner(id: string): void {
  HOME = id;
}

export function getPartners(): Partner[] {
  return PARTNERS.slice();
}

export function getPartner(id: string): Partner | null {
  return PARTNERS.find((p) => p.id === id) ?? null;
}

export function partnerName(id: string): string {
  const p = getPartner(id);
  return p ? p.name : id === ALL_PARTNERS ? 'All partners' : id;
}

export function homePartner(): string {
  return HOME;
}

export interface AddPartnerInput {
  name: string;
  weight?: number;
  status?: Partner['status'];
  since?: string;
  partnerRate?: number;
  agentRate?: number;
}

export function addPartner(input: AddPartnerInput): Partner {
  const base = (input.name || 'partner').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 18) || 'partner';
  let id = base;
  let n = 2;
  while (getPartner(id)) {
    id = base + n;
    n++;
  }
  const rec: Partner = {
    id,
    name: input.name,
    weight: input.weight != null ? input.weight : 0.08,
    status: input.status || 'active',
    users: 0,
    apps: 0,
    since: input.since || new Date().toISOString().slice(0, 7),
    partnerRate: input.partnerRate != null ? input.partnerRate : DEFAULT_PARTNER_RATE,
    agentRate: input.agentRate != null ? input.agentRate : DEFAULT_AGENT_RATE,
  };
  PARTNERS.push(rec);
  persist();
  return rec;
}

export function updatePartner(id: string, changes: Partial<Partner>): Partner | null {
  const p = getPartner(id);
  if (!p) return null;
  (Object.keys(changes) as (keyof Partner)[]).forEach((k) => {
    const v = changes[k];
    if (v !== undefined) (p as Record<keyof Partner, unknown>)[k] = v;
  });
  persist();
  return p;
}

/* ---- Governed partner-settings edit (rates, status, live-from) with audit ----
   Rate edits change ONLY the partner's live rate, used by NEW applications from
   now on. Existing applications keep their snapshotted rate (see FullApp /
   create_referral), so no historical figure moves. Every changed field is
   recorded to an immutable audit trail (who, when, old -> new). */
export interface PartnerSettingsInput {
  name: string;
  status: PartnerStatus;
  since: string; // 'YYYY-MM' or ''
  partnerRate: number; // fraction of one month's rent
  agentRate: number;
}

export interface PartnerAuditEntry {
  field: 'partner_rate' | 'agent_rate' | 'status' | 'live_from' | 'name' | string;
  oldValue: string;
  newValue: string;
  actor: string;
  at: Date;
}

// Mock/test audit store, keyed by partner id (slug). Supabase mode uses the
// partner_audit table + update_partner_settings RPC instead.
const PARTNER_AUDIT: Record<string, PartnerAuditEntry[]> = {};
const pct = (f: number): string => `${Math.round(f * 100)}%`;

/**
 * Persist a partner-settings edit. Supabase mode calls the update_partner_settings
 * RPC (admin + AAL2 enforced; writes the audit rows and updates the partner in one
 * transaction). Mock mode records the diffs to the in-memory audit and updates the
 * working copy. Existing applications are never touched, by design.
 */
export async function updatePartnerSettings(id: string, next: PartnerSettingsInput): Promise<void> {
  const cur = getPartner(id);
  if (!cur) throw new Error('Partner not found.');
  if (SUPABASE_ENABLED) {
    const { error } = await sb().rpc('update_partner_settings', {
      p_slug: id,
      p_name: next.name,
      p_status: next.status,
      p_live_from: next.since ? `${next.since}-01` : null,
      p_partner_rate: next.partnerRate,
      p_agent_rate: next.agentRate,
    });
    if (error) throw new Error(error.message);
    return; // caller re-hydrates (session.refresh) to pick up the new live rate
  }
  // Mock mode: record the audit diffs, then update the working copy.
  const who = 'You';
  const entries: PartnerAuditEntry[] = [];
  const add = (field: PartnerAuditEntry['field'], oldValue: string, newValue: string) =>
    entries.push({ field, oldValue, newValue, actor: who, at: new Date() });
  if (cur.partnerRate !== next.partnerRate) add('partner_rate', pct(cur.partnerRate), pct(next.partnerRate));
  if (cur.agentRate !== next.agentRate) add('agent_rate', pct(cur.agentRate), pct(next.agentRate));
  if (cur.status !== next.status) add('status', cur.status, next.status);
  if ((cur.since || '') !== (next.since || '')) add('live_from', cur.since || '—', next.since || '—');
  if (cur.name !== next.name) add('name', cur.name, next.name);
  if (entries.length) PARTNER_AUDIT[id] = [...entries, ...(PARTNER_AUDIT[id] ?? [])];
  // Pass since as-is (not `|| undefined`) so clearing Live-from actually clears it
  // and matches the audit entry recorded above.
  updatePartner(id, {
    name: next.name, status: next.status, since: next.since,
    partnerRate: next.partnerRate, agentRate: next.agentRate,
  });
}

/** Recent partner-change audit entries (most recent first). Admin-scoped. */
export async function getPartnerAudit(id: string): Promise<PartnerAuditEntry[]> {
  if (SUPABASE_ENABLED) {
    // Resolve the partner id from the slug first, then filter partner_audit by
    // partner_id directly. Filtering via an embedded resource (partner.slug on a
    // !inner join) is fragile and returned nothing, so the panel never rendered
    // (#70). A plain column filter is robust.
    const { data: p } = await sb().from('partners').select('id').eq('slug', id).maybeSingle();
    if (!p?.id) return [];
    const { data, error } = await sb()
      .from('partner_audit')
      .select('field, old_value, new_value, actor, at')
      .eq('partner_id', p.id)
      .order('at', { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((r: any) => ({
      field: r.field,
      oldValue: r.old_value ?? '',
      newValue: r.new_value ?? '',
      actor: r.actor ?? 'opndoor admin',
      at: new Date(r.at),
    }));
  }
  return PARTNER_AUDIT[id] ?? [];
}

/** Per-partner commission rates for a scope. For "all", returns the primary partner's rates. */
export function getRatesFor(scope: PartnerScope): CommissionRates {
  const p = scope && scope !== ALL_PARTNERS ? getPartner(scope) : PARTNERS.find((x) => x.primary) ?? PARTNERS[0];
  return {
    partner: p && p.partnerRate != null ? p.partnerRate : DEFAULT_PARTNER_RATE,
    agent: p && p.agentRate != null ? p.agentRate : DEFAULT_AGENT_RATE,
  };
}

/* ---- opndoor admin's selected partner scope (persisted UI preference) ---- */
export function getSelectedPartner(): PartnerScope {
  return loadString(KEYS.partner) || ALL_PARTNERS;
}
export function setSelectedPartner(id: PartnerScope): void {
  saveString(KEYS.partner, id);
}

/** Central partner-isolation rule: admin follows the selector; others are pinned home. */
export function scopeFor(role: Role): PartnerScope {
  return role === 'superadmin' ? getSelectedPartner() : HOME;
}

/** Demo analytics weight for a scope ("all" sums every partner's weight). */
export function weightFor(scope: PartnerScope): number {
  if (scope === ALL_PARTNERS) return PARTNERS.reduce((s, p) => s + (p.weight || 0), 0);
  const p = getPartner(scope);
  return p ? p.weight : 1;
}
