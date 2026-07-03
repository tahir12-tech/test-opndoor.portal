/* =====================================================================
   Hydrate the service-layer working copies from Supabase.

   Every read screen consumes the four base datasets (partners, org, users,
   applications) through the existing synchronous services. We load those
   datasets once, RLS-scoped to the signed-in user, and replace the mock
   working copies with real data shaped identically. The derived services
   (analytics, league, exports, reconciliation, activity) then reflect real
   data with no screen changes. Runs after AAL2 login; see SessionContext.
   ===================================================================== */
import { sb } from '@/lib/supabase';
import {
  hydratePartners, hydrateUsers, hydrateOrg, hydrateApplications, hydrateUpcoming, hydrateFull,
  type Agency, type AgentContact, type ApplicationSummary, type Branch, type FullApp, type ManagedUser,
  type Partner, type Status,
} from '@/data';
import type { AppRecord } from '@/data/mock/applications';
import type { UpcomingGuaranteeSeed } from '@/data/mock/guarantees';

const DAY = 86400000;

/* eslint-disable @typescript-eslint/no-explicit-any */
const emb = (x: any): any => (Array.isArray(x) ? x[0] : x);
const num = (x: any): number => Number(x ?? 0);

function money(n: number): string {
  if (n >= 1_000_000) return `£${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `£${Math.round(n / 1_000)}k`;
  return `£${Math.round(n)}`;
}

/** Property display string: "addr1, OUTCODE" (upcoming rows already embed the area). */
function propStr(addr1: string, postcode: string | null): string {
  if (!postcode) return addr1;
  return `${addr1}, ${String(postcode).split(' ')[0]}`;
}

function isoDate(ts: string | null): string {
  if (!ts) return '';
  return new Date(ts).toISOString().slice(0, 10);
}

/** The record's anchor date: deed issued, else paid, else sent. */
function eventDate(a: any): string {
  return isoDate(a.deed_issued_at) || isoDate(a.paid_at) || isoDate(a.sent_at);
}

/** The anchor event's epoch ms (same priority as eventDate), for a precise sort. */
function eventTs(a: any): number {
  const ts = a.deed_issued_at || a.paid_at || a.sent_at;
  return ts ? new Date(ts).getTime() : 0;
}

function relTime(ts: string | null, status: string): string {
  if (!ts) return status === 'pending' ? 'Pending invite' : '—';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const wks = Math.round(days / 7);
  return `${wks} week${wks === 1 ? '' : 's'} ago`;
}

function toContact(c: any): AgentContact {
  return {
    name: c.name,
    email: c.email,
    phone: c.phone || '',
    role: c.contact_role || '',
    primary: !!c.is_primary,
  };
}

/** Load all RLS-scoped datasets and replace the service working copies. */
export async function hydrateFromSupabase(userId: string): Promise<void> {
  const client = sb();
  const [partnersRes, usersRes, agenciesRes, branchesRes, contactsRes, appsRes] = await Promise.all([
    client.from('partners').select('id, slug, name, status, live_from, partner_rate, agent_rate, is_primary'),
    client.from('users').select('id, full_name, email, role, status, last_active_at, partner_id, partner:partners(slug)'),
    client.from('agencies').select('id, name, group_name, unreviewed, partner_id, partner:partners(slug)'),
    client.from('branches').select('id, name, area, unreviewed, agency_id, partner_id'),
    client.from('agent_contacts').select('id, name, email, phone, contact_role, is_primary, agency_id, branch_id'),
    client.from('applications').select(
      'id, guarantee_ref, tenant_title, tenant_first_name, tenant_last_name, ' +
        'tenant_dob, tenant_email, tenant_phone, ' +
        'prop_addr1, prop_addr2, prop_city, prop_county, prop_postcode, ' +
        'monthly_rent, status, beneficiary, tenancy_start, sent_at, paid_at, deed_issued_at, expiry_date, ' +
        'payment_state, refunded_at, refunded_amount, paid_amount, refund_after_start, ' +
        'deed_state, deed_sent_at, deed_viewed_at, expiry_reminders_sent, ' +
        'referrer_id, branch_id, agency_id, partner_id, ' +
        'branch:branches(name), agency:agencies(name), referrer:users!referrer_id(full_name, role), partner:partners(slug)',
    ),
  ]);

  for (const res of [partnersRes, usersRes, agenciesRes, branchesRes, contactsRes, appsRes]) {
    if (res.error) throw new Error(`Failed to load data: ${res.error.message}`);
  }

  const partners = (partnersRes.data ?? []) as any[];
  const users = (usersRes.data ?? []) as any[];
  const agencies = (agenciesRes.data ?? []) as any[];
  const branches = (branchesRes.data ?? []) as any[];
  const contacts = (contactsRes.data ?? []) as any[];
  const apps = (appsRes.data ?? []) as any[];

  const partnerSlug = new Map<string, string>(partners.map((p) => [p.id, p.slug]));
  const slugOfApp = (a: any): string => emb(a.partner)?.slug ?? partnerSlug.get(a.partner_id) ?? '';
  const fullName = (a: any): string => `${a.tenant_first_name} ${a.tenant_last_name}`;
  const ownerFlag = (a: any): number => (a.referrer_id === userId ? 1 : 0);

  /* ---- users ---- */
  const usersOut: ManagedUser[] = users.map((u) => ({
    id: u.id,
    name: u.full_name,
    role: u.role,
    lastActive: relTime(u.last_active_at, u.status),
    status: u.status,
    partner: u.role === 'superadmin' ? 'opndoor' : (emb(u.partner)?.slug ?? ''),
  }));

  /* ---- partners (with derived weight/users/apps counts) ---- */
  const usersByPartner: Record<string, number> = {};
  users.forEach((u) => {
    const s = emb(u.partner)?.slug;
    if (s) usersByPartner[s] = (usersByPartner[s] || 0) + 1;
  });
  const appsByPartner: Record<string, number> = {};
  apps.forEach((a) => {
    const s = slugOfApp(a);
    if (s) appsByPartner[s] = (appsByPartner[s] || 0) + 1;
  });
  const maxApps = Math.max(1, ...Object.values(appsByPartner));

  const partnersOut: Partner[] = partners.map((p) => ({
    id: p.slug,
    name: p.name,
    status: p.status,
    since: p.live_from ? String(p.live_from).slice(0, 7) : '',
    weight: (appsByPartner[p.slug] || 0) / maxApps || 0.05,
    ...(p.is_primary ? { primary: true } : {}),
    users: usersByPartner[p.slug] || 0,
    apps: appsByPartner[p.slug] || 0,
    partnerRate: num(p.partner_rate),
    agentRate: num(p.agent_rate),
  }));

  /* ---- org (agencies -> branches -> contacts + derived metrics) ---- */
  const appsByBranch: Record<string, any[]> = {};
  const appsByAgency: Record<string, any[]> = {};
  apps.forEach((a) => {
    (appsByBranch[a.branch_id] ??= []).push(a);
    (appsByAgency[a.agency_id] ??= []).push(a);
  });
  const branchesByAgency: Record<string, any[]> = {};
  branches.forEach((b) => (branchesByAgency[b.agency_id] ??= []).push(b));
  const contactsByAgency: Record<string, any[]> = {};
  const contactsByBranch: Record<string, any[]> = {};
  contacts.forEach((c) => {
    if (c.agency_id) (contactsByAgency[c.agency_id] ??= []).push(c);
    else if (c.branch_id) (contactsByBranch[c.branch_id] ??= []).push(c);
  });
  const sum = (rows: any[], f: (a: any) => number): number => rows.reduce((s, a) => s + f(a), 0);
  // Fees collected net of refunds: paid fees minus refunded amounts. Commission
  // downstream (league, exports) is fees x rate, so refunded fees pay none.
  const feesNet = (rows: any[]): number =>
    sum(rows, (x) => (x.status === 'paid' || x.status === 'deed' ? num(x.monthly_rent) : 0)) -
    sum(rows, (x) => (x.payment_state === 'refunded' ? num(x.refunded_amount ?? x.monthly_rent) : 0));

  const agenciesOut: Agency[] = agencies.map((a) => {
    const brs: Branch[] = (branchesByAgency[a.id] ?? []).map((b) => {
      const bApps = appsByBranch[b.id] ?? [];
      const branch: Branch = {
        name: b.name,
        area: b.area || '—',
        referrers: new Set(bApps.map((x) => x.referrer_id)).size,
        referrals: bApps.length,
        guaranteed: money(sum(bApps, (x) => num(x.monthly_rent) * 12)),
        fees: feesNet(bApps),
        contacts: (contactsByBranch[b.id] ?? []).map(toContact),
      };
      if (b.unreviewed) branch.unreviewed = true;
      return branch;
    });
    const aApps = appsByAgency[a.id] ?? [];
    const agency: Agency = {
      partner: emb(a.partner)?.slug ?? partnerSlug.get(a.partner_id) ?? '',
      name: a.name,
      referrals: aApps.length,
      guaranteed: money(sum(aApps, (x) => num(x.monthly_rent) * 12)),
      fees: feesNet(aApps),
      contacts: (contactsByAgency[a.id] ?? []).map(toContact),
      branches: brs,
    };
    if (a.group_name) agency.group = a.group_name;
    if (a.unreviewed) agency.unreviewed = true;
    return agency;
  });

  /* ---- applications: summaries + detail records ---- */
  const listOut: ApplicationSummary[] = apps.map((a) => ({
    ref: a.guarantee_ref,
    tenant: fullName(a),
    prop: propStr(a.prop_addr1, a.prop_postcode),
    branch: emb(a.branch)?.name ?? '',
    agency: emb(a.agency)?.name ?? '',
    ben: a.beneficiary ?? '',
    rent: num(a.monthly_rent),
    status: a.status as Status,
    date: eventDate(a),
    eventTs: eventTs(a),
    owner: ownerFlag(a),
    partner: slugOfApp(a),
    refunded: a.payment_state === 'refunded',
    awaitingSignature: a.deed_state === 'awaiting_tenant',
  }));

  const toDate = (ts: any): Date | null => (ts ? new Date(ts) : null);
  // Postgres DATE columns (tenancy_start, expiry_date) arrive as bare
  // 'YYYY-MM-DD'. new Date() would parse them as UTC midnight, which then
  // misbuckets/off-by-ones under local-time comparisons and formatting (e.g. the
  // bordereau's monthly window). Parse them at LOCAL midnight instead.
  const toLocalDate = (s: any): Date | null => {
    if (!s) return null;
    const p = String(s).slice(0, 10).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  };
  const fullOut: FullApp[] = apps.map((a) => ({
    ref: a.guarantee_ref,
    partner: slugOfApp(a),
    agency: emb(a.agency)?.name ?? '',
    branch: emb(a.branch)?.name ?? '',
    referrer: emb(a.referrer)?.full_name ?? '',
    referrerRole: (emb(a.referrer)?.role ?? null) as any,
    owner: ownerFlag(a),
    status: a.status as Status,
    rent: num(a.monthly_rent),
    sentAt: toDate(a.sent_at),
    paidAt: toDate(a.paid_at),
    deedAt: toDate(a.deed_issued_at),
    tenancyStart: toLocalDate(a.tenancy_start),
    expiry: toLocalDate(a.expiry_date),
    refunded: a.payment_state === 'refunded',
    refundedAt: toDate(a.refunded_at),
    refundedAmount: a.refunded_amount != null ? num(a.refunded_amount) : null,
    refundAfterStart: !!a.refund_after_start,
    deedState: a.deed_state ?? null,
    deedSentAt: toDate(a.deed_sent_at),
    deedViewedAt: toDate(a.deed_viewed_at),
  }));

  const recordsOut: AppRecord[] = apps.map((a) => ({
    ref: a.guarantee_ref,
    name: fullName(a),
    title: a.tenant_title ?? '',
    role: '',
    addr1: a.prop_addr1,
    postcode: a.prop_postcode ?? '',
    branch: emb(a.branch)?.name ?? '',
    agency: emb(a.agency)?.name ?? '',
    rent: num(a.monthly_rent),
    status: a.status as Status,
    date: eventDate(a),
    referrer: emb(a.referrer)?.full_name ?? '',
    owner: ownerFlag(a),
    // Real values so the detail view shows exactly what was entered, and when.
    firstName: a.tenant_first_name ?? null,
    lastName: a.tenant_last_name ?? null,
    dob: a.tenant_dob ?? null,
    email: a.tenant_email ?? null,
    phone: a.tenant_phone ?? null,
    addr2: a.prop_addr2 ?? null,
    city: a.prop_city ?? null,
    county: a.prop_county ?? null,
    tenancyStartTs: a.tenancy_start ?? null,
    sentAtTs: a.sent_at ?? null,
    paidAtTs: a.paid_at ?? null,
    deedAtTs: a.deed_issued_at ?? null,
  }));

  /* ---- upcoming expiries: near-term in-force (deed) guarantees ---- */
  const horizon = Date.now() + 90 * DAY;
  const upcomingOut: UpcomingGuaranteeSeed[] = apps
    // In-force = Deed Issued AND not refunded (matches fire_expiry_reminders), so a
    // refunded guarantee never shows here looking like it should get reminders.
    .filter((a) => a.status === 'deed' && a.payment_state !== 'refunded' && a.expiry_date && new Date(a.expiry_date).getTime() <= horizon)
    .map((a) => ({
      ref: a.guarantee_ref,
      tenant: fullName(a),
      prop: propStr(a.prop_addr1, a.prop_postcode),
      branch: emb(a.branch)?.name ?? '',
      agency: emb(a.agency)?.name ?? '',
      partner: slugOfApp(a),
      owner: ownerFlag(a),
      tenancyStart: a.tenancy_start,
      remindersSent: a.expiry_reminders_sent ?? 0,
    }));

  hydratePartners(partnersOut);
  hydrateUsers(usersOut);
  hydrateOrg(agenciesOut);
  hydrateApplications(listOut, recordsOut);
  hydrateUpcoming(upcomingOut);
  hydrateFull(fullOut);
}
