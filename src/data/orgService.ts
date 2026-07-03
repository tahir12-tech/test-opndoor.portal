/* =====================================================================
   Organisation service — agencies + branches.
   Backed by a working copy persisted to localStorage so additions made on
   the new-application form appear on the Agencies & branches screen and
   vice versa.

   INTEGRATION: getAgencies -> GET /agencies?partner=; search* -> scoped
   search endpoints; createAgency/BranchOnTheFly -> POST that returns the
   new id and FLAGS the record for reconciliation (unreviewed = true).
   ===================================================================== */
import type { Agency, AgentContact, Branch, PartnerScope } from './types';
import { ALL_PARTNERS } from './types';
import { KEYS, clone, loadJSON, saveJSON } from './storage';
import { ORG_SEED } from './mock/org';
import { homePartner } from './partnersService';

let AGENCIES: Agency[] = loadJSON<Agency[]>(KEYS.org, clone(ORG_SEED));
if (!AGENCIES.length) AGENCIES = clone(ORG_SEED);

function persist(): void {
  saveJSON(KEYS.org, AGENCIES);
}

/** Replace the agencies/branches/contacts tree from the back end (Supabase mode). */
export function hydrateOrg(agencies: Agency[]): void {
  AGENCIES = agencies.slice();
}

function partnerOf(a: Agency): string {
  return a.partner || homePartner();
}

/** All agencies within a partner scope ("all" returns every partner's agencies). */
export function getAgencies(scope: PartnerScope): Agency[] {
  if (scope === ALL_PARTNERS) return AGENCIES.slice();
  return AGENCIES.filter((a) => partnerOf(a) === scope);
}

export function findAgency(name: string): Agency | undefined {
  return AGENCIES.find((a) => a.name === name);
}

/** Same as findAgency but returns null. Internal helper for createBranchOnTheFly. */
function findAgencyByName(name: string): Agency | null {
  return AGENCIES.find((a) => a.name === name) ?? null;
}

/* =====================================================================
   Agent contacts. A branch uses its own contacts if it has any, otherwise
   it inherits the parent agency's (the agency is the default). Exactly one
   contact is primary per owner. These resolvers are pure; the mutations
   persist and enforce the one-primary-per-owner invariant.
   ===================================================================== */

/** The flagged primary contact, else the first, else null. Internal helper. */
function primaryOf(contacts?: AgentContact[]): AgentContact | null {
  if (!contacts || !contacts.length) return null;
  return contacts.find((c) => c.primary) ?? contacts[0];
}

/** The contacts that apply to a branch: its own if any, otherwise the agency's. */
export function effectiveContacts(agency: Agency | null, branch?: Branch | null): { list: AgentContact[]; inherited: boolean } {
  const own = branch && branch.contacts ? branch.contacts : [];
  if (own.length) return { list: own, inherited: false };
  return { list: agency && agency.contacts ? agency.contacts : [], inherited: true };
}

export function effectivePrimary(agency: Agency | null, branch?: Branch | null): { contact: AgentContact | null; inherited: boolean } {
  const eff = effectiveContacts(agency, branch);
  return { contact: primaryOf(eff.list), inherited: eff.inherited };
}

/** Resolve the deed recipient for an application at (agency, branch). */
export function contactForApplication(agencyName: string, branchName: string): { contact: AgentContact | null; inherited: boolean; agency: Agency | null; branch: Branch | null } {
  const agency = findAgencyByName(agencyName);
  if (!agency) return { contact: null, inherited: false, agency: null, branch: null };
  const branch = (agency.branches || []).find((b) => b.name === branchName) ?? null;
  const ep = effectivePrimary(agency, branch);
  return { contact: ep.contact, inherited: ep.inherited, agency, branch };
}

/* ---- contact mutations (used by the org contact-management UI) ---- */

/** The owner object to mutate: a branch when branchName is given, else the agency. */
function contactOwner(agencyName: string, branchName: string | null): Agency | Branch | null {
  const agency = findAgency(agencyName);
  if (!agency) return null;
  if (!branchName) return agency;
  return (agency.branches || []).find((b) => b.name === branchName) ?? null;
}
function ownerList(owner: Agency | Branch): AgentContact[] {
  if (!owner.contacts) owner.contacts = [];
  return owner.contacts;
}

export function addContact(agencyName: string, branchName: string | null, contact: AgentContact): void {
  const owner = contactOwner(agencyName, branchName);
  if (!owner) return;
  const list = ownerList(owner);
  const rec: AgentContact = { ...contact };
  if (rec.primary) list.forEach((c) => (c.primary = false));
  if (!list.length) rec.primary = true; // the first contact is always primary
  list.push(rec);
  persist();
}

export function updateContact(agencyName: string, branchName: string | null, index: number, contact: AgentContact): void {
  const owner = contactOwner(agencyName, branchName);
  if (!owner) return;
  const list = ownerList(owner);
  if (index < 0 || index >= list.length) return;
  const rec: AgentContact = { ...contact };
  if (rec.primary) list.forEach((c) => (c.primary = false));
  list[index] = rec;
  persist();
}

export function removeContact(agencyName: string, branchName: string | null, index: number): void {
  const owner = contactOwner(agencyName, branchName);
  if (!owner || !owner.contacts) return;
  const list = owner.contacts;
  if (index < 0 || index >= list.length) return;
  const wasPrimary = list[index].primary;
  list.splice(index, 1);
  if (wasPrimary && list.length) list[0].primary = true; // promote the first remaining
  persist();
}

export function setPrimaryContact(agencyName: string, branchName: string | null, index: number): void {
  const owner = contactOwner(agencyName, branchName);
  if (!owner || !owner.contacts) return;
  owner.contacts.forEach((c, i) => (c.primary = i === index));
  persist();
}

/** Type-ahead: agencies within scope whose name matches the query. */
export function searchAgencies(query: string, scope: PartnerScope): Agency[] {
  const ql = query.trim().toLowerCase();
  return getAgencies(scope).filter((a) => !ql || a.name.toLowerCase().includes(ql));
}

/** Type-ahead: branches of an agency whose name matches the query. */
export function searchBranches(agencyName: string, query: string): Branch[] {
  const agency = findAgency(agencyName);
  if (!agency) return [];
  const ql = query.trim().toLowerCase();
  return agency.branches.filter((b) => !ql || b.name.toLowerCase().includes(ql));
}

export interface AddAgencyInput {
  name: string;
  group?: string;
}

/** Add an agency from the Agencies & branches screen (stamped to the active partner). */
export function addAgency(input: AddAgencyInput, scope: PartnerScope): Agency {
  const partner = scope === ALL_PARTNERS ? homePartner() : scope;
  const agency: Agency = { name: input.name, partner, users: 0, referrals: 0, guaranteed: '£0', fees: 0, open: true, branches: [] };
  if (input.group) agency.group = input.group;
  AGENCIES.push(agency);
  persist();
  return agency;
}

export interface AddBranchInput {
  name: string;
  area?: string;
}

export function addBranch(agencyName: string, input: AddBranchInput): Branch | null {
  const agency = findAgency(agencyName);
  if (!agency) return null;
  const branch: Branch = { name: input.name, area: input.area || '—', referrers: 0, referrals: 0, guaranteed: '£0' };
  agency.branches.push(branch);
  agency.open = true;
  persist();
  return branch;
}

/** Create an agency on the fly from the referral form. Flagged unreviewed for reconciliation. */
export function createAgencyOnTheFly(name: string, scope: PartnerScope): Agency {
  const partner = scope === ALL_PARTNERS ? homePartner() : scope;
  const agency: Agency = { name, partner, users: 0, referrals: 0, guaranteed: '£0', fees: 0, branches: [], unreviewed: true };
  AGENCIES.push(agency);
  persist();
  return agency;
}

/** Create a branch on the fly under an agency. Flagged unreviewed for reconciliation. */
export function createBranchOnTheFly(agencyName: string, name: string): Branch | null {
  const agency = findAgency(agencyName);
  if (!agency) return null;
  const branch: Branch = { name, area: '—', referrers: 0, referrals: 0, guaranteed: '£0', unreviewed: true };
  agency.branches.push(branch);
  persist();
  return branch;
}

/** Derived counts for a partner (used by the Partners screen). */
export function orgCounts(partnerId: string): { agencies: number; branches: number } {
  let agencies = 0;
  let branches = 0;
  AGENCIES.forEach((a) => {
    if (partnerOf(a) === partnerId) {
      agencies++;
      branches += a.branches ? a.branches.length : 0;
    }
  });
  return { agencies, branches };
}
