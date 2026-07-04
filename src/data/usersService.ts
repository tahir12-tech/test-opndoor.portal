/* =====================================================================
   Users service.
   Enforces the visibility rules: opndoor admin accounts never appear in a
   partner user list; the opndoor team view shows only opndoor staff;
   Management sees only its own partner. Held in memory (the prototype did
   not persist users), so it resets on reload.

   INTEGRATION: getUsers -> GET /users with scope/team; addUser, updateRole,
   reset password, reset 2FA, resend invite and deactivate -> the matching
   mutations. Every rule here must also be enforced server-side.
   ===================================================================== */
import type { Role, User, UserStatus } from './types';
import { ALL_PARTNERS } from './types';
import { getSelectedPartner, homePartner, partnerName } from './partnersService';
import { functionErrorMessage } from './paymentService';
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';

// [name, role, lastActive, status, partner] — ported from user-management.html
const SEED: [string, Role, string, UserStatus, string][] = [
  ['Maya Holloway', 'superadmin', '2 minutes ago', 'active', 'opndoor'],
  ['Tom Sefton', 'management', '1 hour ago', 'active', 'rightmove'],
  ['Priya Nair', 'referrer', '12 minutes ago', 'active', 'rightmove'],
  ['James Okafor', 'referrer', 'Yesterday', 'active', 'rightmove'],
  ['Sophie Bennett', 'referrer', '3 hours ago', 'active', 'rightmove'],
  ['Rachel Adeyemi', 'management', 'Yesterday', 'active', 'rightmove'],
  ['Daniel Wright', 'referrer', '2 days ago', 'active', 'rightmove'],
  ['Aisha Khan', 'referrer', '5 hours ago', 'active', 'rightmove'],
  ['Marcus Lin', 'referrer', '1 day ago', 'active', 'rightmove'],
  ['Eleanor Voss', 'management', '4 days ago', 'active', 'rightmove'],
  ['Oliver Grant', 'referrer', '6 hours ago', 'active', 'rightmove'],
  ['Naomi Clarke', 'referrer', 'Pending invite', 'pending', 'rightmove'],
  ['Greg Mason', 'management', 'Yesterday', 'active', 'zoopla'],
  ['Hannah Pryce', 'referrer', '2 days ago', 'active', 'zoopla'],
  ['Owen Black', 'management', '3 days ago', 'active', 'onthemarket'],
  ['Ruth Findlay', 'referrer', '1 week ago', 'active', 'onthemarket'],
];

export interface ManagedUser extends User {
  id: string;
}

export function emailOf(name: string): string {
  return `${name.toLowerCase().replace(/ /g, '.')}@brackenhouse.co.uk`;
}

let USERS: ManagedUser[] = SEED.map((u, i) => ({ id: `u${i}`, name: u[0], email: emailOf(u[0]), role: u[1], lastActive: u[2], status: u[3], partner: u[4] }));

/** Replace the users working copy from the back end (Supabase mode). */
export function hydrateUsers(users: ManagedUser[]): void {
  USERS = users.slice();
}

/** Display email for a managed user (real in Supabase mode, derived otherwise). */
export function userEmail(u: ManagedUser): string {
  return u.email || emailOf(u.name);
}

export interface GetUsersOpts {
  viewer: Role;
  /** true for the ?team=opndoor view (opndoor admin only). */
  team: boolean;
  /** opndoor admin's selected partner scope; defaults to the persisted selection. */
  scope?: string;
}

/** Users visible to the viewer, following the partner-isolation and team rules. */
export function getUsers(opts: GetUsersOpts): ManagedUser[] {
  const scope = opts.viewer === 'superadmin' ? opts.scope ?? getSelectedPartner() : homePartner();
  return USERS.filter((u) => {
    if (opts.team) return u.role === 'superadmin'; // opndoor team: opndoor's own staff only
    if (u.role === 'superadmin') return false; // partner lists never include opndoor staff
    if (opts.viewer === 'management' && u.partner !== homePartner()) return false;
    if (opts.viewer === 'superadmin' && scope !== ALL_PARTNERS && u.partner !== scope) return false;
    return true;
  });
}

/* ---- User lifecycle actions (Supabase RPCs in live mode; working copy + audit
   in mock mode). Every rule (role wall, self/last-admin guard) is enforced
   server-side in the RPC; the client mirrors it for a clean UX. ---- */

export type UserAction = 'status' | 'role' | 'reset_mfa';
export interface UserAuditEntry {
  action: UserAction | string;
  oldValue: string;
  newValue: string;
  actor: string;
  at: Date;
}

// Mock/test audit store, keyed by user id. Supabase mode uses the user_audit table.
const USER_AUDIT: Record<string, UserAuditEntry[]> = {};
function recordUserAudit(id: string, action: UserAction, oldValue: string, newValue: string): void {
  USER_AUDIT[id] = [{ action, oldValue, newValue, actor: 'You', at: new Date() }, ...(USER_AUDIT[id] ?? [])];
}

/** Change a user's role (Referrer/Management/opndoor admin), behind the role wall. */
export async function updateUserRole(id: string, role: Role): Promise<void> {
  const u = USERS.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (SUPABASE_ENABLED) {
    const { error } = await sb().rpc('admin_update_user_role', { p_user: id, p_role: role });
    if (error) throw new Error(error.message);
    return; // caller re-hydrates
  }
  const old = u.role;
  if (old !== role) recordUserAudit(id, 'role', old, role);
  u.role = role;
}

/** Deactivate or reactivate a user (ban/unban + revoke sessions in live mode). */
export async function setUserStatus(id: string, status: 'active' | 'deactivated'): Promise<void> {
  const u = USERS.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (SUPABASE_ENABLED) {
    const { error } = await sb().rpc('admin_set_user_status', { p_user: id, p_status: status });
    if (error) throw new Error(error.message);
    return;
  }
  const old = u.status;
  if (old !== status) recordUserAudit(id, 'status', old, status);
  u.status = status;
}

/** Reset a user's 2FA: they re-enrol at next sign in. */
export async function resetUserMfa(id: string): Promise<void> {
  const u = USERS.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (SUPABASE_ENABLED) {
    const { error } = await sb().rpc('admin_reset_user_mfa', { p_user: id });
    if (error) throw new Error(error.message);
    return;
  }
  recordUserAudit(id, 'reset_mfa', 'enrolled', 'reset');
}

/** Send a password-reset link to a user's email (live mode). No-op in mock mode.
    Routes through the send-password-reset Edge Function (branded Resend email,
    redirected to the review address in this test build) rather than GoTrue's
    built-in mailer, so it honours the review-redirect convention and lands on
    the app's /reset-password screen. */
export async function resetUserPassword(id: string): Promise<void> {
  const u = USERS.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (SUPABASE_ENABLED) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const { error } = await sb().functions.invoke('send-password-reset', { body: { email: userEmail(u), origin } });
    if (error) throw new Error(error.message);
  }
}

/** Recent lifecycle changes for a user (most recent first). Admin/management scoped. */
export async function getUserAudit(id: string): Promise<UserAuditEntry[]> {
  if (SUPABASE_ENABLED) {
    const { data, error } = await sb()
      .from('user_audit')
      .select('action, old_value, new_value, actor, at')
      .eq('target_user', id)
      .order('at', { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((r: any) => ({
      action: r.action,
      oldValue: r.old_value ?? '',
      newValue: r.new_value ?? '',
      actor: r.actor ?? 'an administrator',
      at: new Date(r.at),
    }));
  }
  return USER_AUDIT[id] ?? [];
}

export interface AddUserInput {
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  partner: string;
}

export function addUser(input: AddUserInput): ManagedUser {
  const name = `${input.firstName || 'New'} ${input.lastName || 'User'}`;
  const partner = input.role === 'superadmin' ? 'opndoor' : input.partner || homePartner();
  const rec: ManagedUser = { id: `u${USERS.length}_${Math.round(performance.now())}`, name, email: input.email.trim() || emailOf(name), role: input.role, lastActive: 'Pending invite', status: 'pending', partner };
  USERS.push(rec);
  return rec;
}

/** Invite a new user: in live mode the invite-user Edge Function creates the
    auth user + public.users row and sends a branded invite email (redirected to
    the review address in test mode) that lands on /accept-invite. Mock mode just
    adds the local pending record. The real row appears on the next hydration. */
export async function inviteUser(input: AddUserInput): Promise<ManagedUser> {
  if (SUPABASE_ENABLED) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const { data, error } = await sb().functions.invoke('invite-user', {
      body: { firstName: input.firstName.trim(), lastName: input.lastName.trim(), email: input.email.trim(), role: input.role, partner: input.partner, origin },
    });
    if (error) throw new Error(await functionErrorMessage(error, 'Could not send the invitation.'));
    if (!data?.ok) throw new Error(data?.error || 'Could not send the invitation.');
    const partner = input.role === 'superadmin' ? 'opndoor' : input.partner || homePartner();
    const name = `${input.firstName} ${input.lastName}`.trim() || input.email.trim();
    return { id: `pending_${input.email.trim()}`, name, email: input.email.trim(), role: input.role, lastActive: 'Pending invite', status: 'pending', partner };
  }
  return addUser(input);
}

/** Resend an invitation (a fresh set-password link) to a pending/known user. */
export async function resendInvite(id: string): Promise<void> {
  const u = USERS.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (SUPABASE_ENABLED) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const parts = (u.name || '').trim().split(/\s+/);
    const { data, error } = await sb().functions.invoke('invite-user', {
      body: { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' '), email: userEmail(u), role: u.role, partner: u.partner === 'opndoor' ? '' : u.partner, origin },
    });
    if (error) throw new Error(await functionErrorMessage(error, 'Could not resend the invitation.'));
    if (!data?.ok) throw new Error(data?.error || 'Could not resend the invitation.');
  }
}

/** Display name of a user's partner (or "opndoor"). */
export function userPartnerName(partner: string): string {
  return partner === 'opndoor' ? 'opndoor' : partnerName(partner);
}
