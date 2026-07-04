/* =====================================================================
   Users — manage partner staff, or the opndoor team (?team=opndoor).
   opndoor admin accounts never appear in a partner list; the opndoor team
   view lists only opndoor staff; Management sees only its own partner.

   Lifecycle is real (Pending / Active / Deactivated) and every state-changing
   action (role change, deactivate, reactivate, reset 2FA) runs through an
   audited, guard-checked service call: a hard role-model wall (partner users
   are Referrer/Management only; opndoor staff are admin only), self-service
   lockout guards (no deactivating/demoting yourself or the last active admin),
   and a confirmation dialog stating the consequence. Reachable by opndoor admin
   + Management (route guard).
   ===================================================================== */
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getPartner, getPartners, getUserAudit, getUsers, homePartner, inviteUser, partnerName,
  resendInvite, resetUserMfa, resetUserPassword, setUserStatus, updateUserRole, userEmail, userPartnerName,
  type ManagedUser, type Role, type UserAuditEntry,
} from '@/data';
import { ALL_PARTNERS } from '@/data';
import { useSession } from '@/session/SessionContext';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Card, CardHead } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Pill, type PillVariant } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import './UserManagement.css';

const ROLE_META: Record<Role, [string, string]> = {
  superadmin: ['opndoor admin', 'role-tag--super'],
  management: ['Management', 'role-tag--mgmt'],
  referrer: ['Referrer', 'role-tag--ref'],
};

const STATUS_PILL: Record<string, [string, PillVariant]> = {
  active: ['Active', 'deed'],
  pending: ['Pending', 'warn'],
  deactivated: ['Deactivated', 'muted'],
};

const AUDIT_LABEL: Record<string, string> = { status: 'Status', role: 'Role', reset_mfa: '2FA' };
const dmy = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

interface RoleOption {
  id: Role;
  name: string;
  desc: string;
}
const ROLE_OPTIONS: RoleOption[] = [
  { id: 'superadmin', name: 'opndoor admin (Super-admin)', desc: "opndoor's internal admin. Full control of the portal: manages agencies, branches and users, syncs with HubSpot, edits help resources, and sees every referral." },
  { id: 'management', name: 'Management', desc: 'Partner management and admin. The same screens and tools as a referrer, but across the whole estate with full visibility of all tracking and analytics. Cannot edit agency and branch records or portal settings.' },
  { id: 'referrer', name: 'Referrer', desc: 'Sees and tracks only their own referrals. Can add agencies and branches on the fly while referring.' },
];

const initials = (n: string) => n.split(' ').map((p) => p[0]).slice(0, 2).join('');

interface ConfirmSpec {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  success: string;
  run: () => Promise<void>;
}

function RoleOptions({ options, selected, onSelect }: { options: RoleOption[]; selected: Role; onSelect: (r: Role) => void }) {
  return (
    <div className="roleopts">
      {options.map((o) => (
        <label key={o.id} className={`roleopt${selected === o.id ? ' is-sel' : ''}`} onClick={() => onSelect(o.id)}>
          <span className="roleopt__radio" />
          <div><div className="roleopt__name">{o.name}</div><div className="roleopt__desc">{o.desc}</div></div>
        </label>
      ))}
    </div>
  );
}

export function UserManagement() {
  const { role, currentUserId, selectedPartner, setSelectedPartner, refresh: refreshData } = useSession();
  const toast = useToast();
  const [params] = useSearchParams();
  const partnerParam = params.get('partner');
  const teamMode = params.get('team') === 'opndoor' && role === 'superadmin';

  usePageMeta(teamMode ? 'opteam' : 'users', 'Users', ['Home', 'Administration', 'Users']);

  // Drill-in from Partners: ?partner=<id> scopes this view.
  useEffect(() => {
    if (partnerParam && getPartner(partnerParam)) setSelectedPartner(partnerParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerParam]);

  const [, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuUp, setMenuUp] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  // add-user modal
  const [addOpen, setAddOpen] = useState(false);
  const [addFirst, setAddFirst] = useState('');
  const [addLast, setAddLast] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState<Role>('referrer');
  const [addPartnerId, setAddPartnerId] = useState('');
  // edit-role modal
  const [editUser, setEditUser] = useState<ManagedUser | null>(null);
  const [editRole, setEditRole] = useState<Role>('referrer');
  const [editAudit, setEditAudit] = useState<UserAuditEntry[]>([]);

  useEffect(() => {
    const close = () => setMenuOpenId(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const allUsers = getUsers({ viewer: role, team: teamMode, scope: selectedPartner });
  const showPartner = role === 'superadmin' && !teamMode;

  // Search across name, email, role label and partner (item: dead search fix).
  const q = query.trim().toLowerCase();
  const users = q
    ? allUsers.filter((u) =>
        u.name.toLowerCase().includes(q) ||
        userEmail(u).toLowerCase().includes(q) ||
        ROLE_META[u.role][0].toLowerCase().includes(q) ||
        userPartnerName(u.partner).toLowerCase().includes(q))
    : allUsers;

  // Self-service + last-admin guards (also enforced server-side in the RPCs).
  const activeAdmins = allUsers.filter((u) => u.role === 'superadmin' && u.status === 'active').length;
  const isSelf = (u: ManagedUser) => currentUserId != null && u.id === currentUserId;
  const isLastActiveAdmin = (u: ManagedUser) => u.role === 'superadmin' && u.status === 'active' && activeAdmins <= 1;
  const canDeactivate = (u: ManagedUser) => u.status === 'active' && !isSelf(u) && !isLastActiveAdmin(u);
  const canEditRole = (u: ManagedUser) => !isSelf(u) && !isLastActiveAdmin(u);

  // ---- role-aware framing ----
  let eyebrow = 'Administration · opndoor admin';
  let sub = 'Partner staff by partner. Drill into a partner from the Partners screen, or view all partners at once here.';
  let cardTitle = selectedPartner === ALL_PARTNERS ? 'All partner users' : `${partnerName(selectedPartner)} users`;
  let cardSub = selectedPartner === ALL_PARTNERS ? 'Every partner, with a Partner column' : 'Users for this partner';
  if (teamMode) {
    eyebrow = 'opndoor · internal team';
    sub = 'opndoor’s own admin staff. They sit above all partners and never appear in a partner’s user list.';
    cardTitle = 'opndoor team';
    cardSub = 'opndoor admin staff only';
  } else if (role === 'management') {
    eyebrow = 'Administration · Management';
    sub = 'Your team’s access to the portal. Add colleagues as Management or Referrer; opndoor admin accounts are managed by opndoor.';
    cardTitle = 'All users';
    cardSub = 'Your partner team';
  }

  // ---- action runners ----
  async function runConfirm() {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      await confirm.run();
      await refreshData();
      refresh();
      toast(confirm.success);
      setConfirm(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function doDirect(fn: () => Promise<void>, success: string) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await refreshData();
      refresh();
      toast(success);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function openEditRole(u: ManagedUser) {
    setEditUser(u);
    setEditRole(u.role);
    setEditAudit([]);
    getUserAudit(u.id).then(setEditAudit).catch(() => setEditAudit([]));
  }

  function handleAction(action: string, u: ManagedUser) {
    if (action === 'edit-role') { openEditRole(u); return; }
    if (action === 'reset-password') {
      void doDirect(() => resetUserPassword(u.id), `Password reset link sent to ${userEmail(u)}.`);
      return;
    }
    if (action === 'resend') {
      void doDirect(() => resendInvite(u.id), `Invitation resent to ${userEmail(u)}.`);
      return;
    }
    if (action === 'reset-2fa') {
      setConfirm({
        title: `Reset 2FA for ${u.name}?`,
        body: <>Their current authenticator stops working immediately and they are signed out. They set up a new authenticator at their next sign in.</>,
        confirmLabel: 'Reset 2FA',
        success: `Two-factor authentication reset for ${u.name}. They will set it up again at next sign in.`,
        run: () => resetUserMfa(u.id),
      });
      return;
    }
    if (action === 'deactivate') {
      setConfirm({
        title: `Deactivate ${u.name}?`,
        body: <>They are signed out immediately and blocked from signing in. Reactivating them is the only way to restore access.</>,
        confirmLabel: 'Deactivate',
        danger: true,
        success: `${u.name} has been deactivated and can no longer sign in.`,
        run: () => setUserStatus(u.id, 'deactivated'),
      });
      return;
    }
    if (action === 'reactivate') {
      setConfirm({
        title: `Reactivate ${u.name}?`,
        body: <>They will be able to sign in again with their existing password and two-factor authentication.</>,
        confirmLabel: 'Reactivate',
        success: `${u.name} has been reactivated and can sign in again.`,
        run: () => setUserStatus(u.id, 'active'),
      });
    }
  }

  function toggleMenu(id: string, btn: HTMLElement) {
    setMenuOpenId((cur) => {
      if (cur === id) return null;
      // Flip the popover upward when there is not enough room below the button.
      const rect = btn.getBoundingClientRect();
      setMenuUp(window.innerHeight - rect.bottom < 260);
      return id;
    });
  }

  function openAdd() {
    setAddFirst('');
    setAddLast('');
    setAddEmail('');
    setAddRole(teamMode ? 'superadmin' : 'referrer');
    setAddPartnerId(selectedPartner !== ALL_PARTNERS ? selectedPartner : homePartner());
    setAddOpen(true);
  }
  async function sendInvite() {
    const email = addEmail.trim();
    if (busy) return;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Enter a valid work email to invite.'); return; }
    setBusy(true);
    try {
      const rec = await inviteUser({ firstName: addFirst.trim(), lastName: addLast.trim(), email, role: addRole, partner: addPartnerId });
      await refreshData();
      refresh();
      setAddOpen(false);
      toast(`Invitation sent to ${email} as ${ROLE_META[addRole][0]}${addRole === 'superadmin' ? '' : ` at ${partnerName(rec.partner)}`}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send the invitation.');
    } finally {
      setBusy(false);
    }
  }

  // Save-role opens a confirmation stating the consequence (then runs the update).
  function requestSaveRole() {
    if (!editUser || editRole === editUser.role) { setEditUser(null); return; }
    const u = editUser;
    const from = ROLE_META[u.role][0];
    const to = ROLE_META[editRole][0];
    setEditUser(null);
    setConfirm({
      title: `Change ${u.name}'s role?`,
      body: <><b>{from}</b> → <b>{to}</b>. Their access changes immediately at their next page load. {editRole === 'management' ? 'They will see the whole estate.' : editRole === 'referrer' ? 'They will see only their own referrals.' : ''}</>,
      confirmLabel: 'Change role',
      success: `${u.name}’s role updated to ${to}.`,
      run: () => updateUserRole(u.id, editRole),
    });
  }

  const addOptions = teamMode ? ROLE_OPTIONS.filter((o) => o.id === 'superadmin') : ROLE_OPTIONS.filter((o) => o.id !== 'superadmin');
  // Role-model wall: the edit dialog only offers roles on the target's side of it.
  const editTargetIsTeam = !!editUser && (editUser.partner === 'opndoor' || editUser.role === 'superadmin');
  const editRoleOptions = editTargetIsTeam ? ROLE_OPTIONS.filter((o) => o.id === 'superadmin') : ROLE_OPTIONS.filter((o) => o.id !== 'superadmin');

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow"><span className="eyebrow__dot" /><span>{eyebrow}</span></div>
          <h1 className="page-head__title" style={{ marginTop: 10 }}>Users</h1>
          <p className="page-head__sub">{sub}</p>
        </div>
        <div className="page-head__actions">
          <Button variant="primary" size="sm" onClick={openAdd}><Icon name="plus" /> Add user</Button>
        </div>
      </div>

      {/* role legend */}
      <div className="toolbar" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        {teamMode ? (
          <span className="role-tag role-tag--super">opndoor admin · full control of the portal</span>
        ) : (
          <>
            <span className="role-tag role-tag--mgmt">Management · full estate, no opndoor admin</span>
            <span className="role-tag role-tag--ref">Referrer · own referrals only</span>
          </>
        )}
      </div>

      <Card>
        <CardHead
          title={cardTitle}
          sub={cardSub}
          actions={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {showPartner && (
                <span className="users-chip">
                  <Icon name="shield" />Partner:{' '}
                  <select value={selectedPartner} onChange={(e) => setSelectedPartner(e.target.value)}>
                    <option value={ALL_PARTNERS}>All partners</option>
                    {getPartners().map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </span>
              )}
              <div className="users-search">
                <Icon name="search" />
                <input type="text" placeholder="Search users" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>
          }
        />
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>User</th>
                {showPartner && <th>Partner</th>}
                <th>Role</th>
                <th>Last active</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const rm = ROLE_META[u.role];
                const sp = STATUS_PILL[u.status] ?? STATUS_PILL.pending;
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="who">
                        <span className="who__av">{initials(u.name)}</span>
                        <div><div className="dt__name">{u.name}</div><div className="dt__sub">{userEmail(u)}</div></div>
                      </div>
                    </td>
                    {showPartner && <td className="soft">{userPartnerName(u.partner)}</td>}
                    <td><span className={`role-tag ${rm[1]}`}>{rm[0]}</span></td>
                    <td className="soft">{u.lastActive}</td>
                    <td><Pill variant={sp[1]}>{sp[0]}</Pill></td>
                    <td style={{ textAlign: 'right' }}>
                      <div className={`rowmenu${menuOpenId === u.id ? ' is-open' : ''}${menuOpenId === u.id && menuUp ? ' rowmenu--up' : ''}`}>
                        <button
                          className="rowmenu__btn"
                          aria-label="User actions"
                          onClick={(e) => { e.stopPropagation(); toggleMenu(u.id, e.currentTarget); }}
                        >
                          <Icon name="dots" size={16} />
                        </button>
                        <div className="rowmenu__pop">
                          {u.status === 'deactivated' ? (
                            <button className="rowmenu__item" onClick={() => { setMenuOpenId(null); handleAction('reactivate', u); }}><Icon name="check" />Reactivate user</button>
                          ) : u.status === 'pending' ? (
                            <>
                              <button className="rowmenu__item" onClick={() => { setMenuOpenId(null); handleAction('resend', u); }}><Icon name="send" />Resend invite</button>
                              {canEditRole(u) && <button className="rowmenu__item" onClick={() => { setMenuOpenId(null); handleAction('edit-role', u); }}><Icon name="edit" />Edit role</button>}
                            </>
                          ) : (
                            <>
                              {canEditRole(u) && <button className="rowmenu__item" onClick={() => { setMenuOpenId(null); handleAction('edit-role', u); }}><Icon name="edit" />Edit role</button>}
                              <button className="rowmenu__item" onClick={() => { setMenuOpenId(null); handleAction('reset-password', u); }}><Icon name="lock" />Reset password</button>
                              <button className="rowmenu__item" onClick={() => { setMenuOpenId(null); handleAction('reset-2fa', u); }}><Icon name="phone" />Reset 2FA</button>
                              {canDeactivate(u) && <>
                                <div className="rowmenu__sep" />
                                <button className="rowmenu__item rowmenu__item--danger" onClick={() => { setMenuOpenId(null); handleAction('deactivate', u); }}><Icon name="ban" />Deactivate user</button>
                              </>}
                            </>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr><td colSpan={showPartner ? 6 : 5} className="soft" style={{ textAlign: 'center', padding: '28px 0' }}>{q ? `No users match “${query.trim()}”.` : 'No users to show yet.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ADD USER */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        width={560}
        title={teamMode ? 'Add opndoor team member' : 'Add user'}
        sub={teamMode ? 'Add an opndoor admin. They sit above all partners with full control of the portal.' : 'Invite a partner team member and set their access level.'}
        footer={<><Button variant="ghost" onClick={() => setAddOpen(false)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={sendInvite} arrow disabled={busy}>{busy ? 'Sending…' : 'Send invite'}</Button></>}
      >
        <div className="form-grid">
          <Field label="First name"><input type="text" placeholder="James" value={addFirst} onChange={(e) => setAddFirst(e.target.value)} /></Field>
          <Field label="Last name"><input type="text" placeholder="Okafor" value={addLast} onChange={(e) => setAddLast(e.target.value)} /></Field>
          <Field label="Work email" span2><input type="email" placeholder="james@brackenhouse.co.uk" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} /></Field>
          {addRole !== 'superadmin' && (
            <Field label="Partner company" span2 hint="opndoor admin users sit above all partners and do not belong to one.">
              <select value={addPartnerId} onChange={(e) => setAddPartnerId(e.target.value)}>
                {getPartners().map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <Field label="Role">
          <RoleOptions options={addOptions} selected={addRole} onSelect={setAddRole} />
        </Field>
      </Modal>

      {/* EDIT ROLE */}
      <Modal
        open={editUser !== null}
        onClose={() => setEditUser(null)}
        title={<>Edit role · {editUser?.name ?? 'User'}</>}
        sub={editUser ? userEmail(editUser) : ''}
        footer={<><Button variant="ghost" onClick={() => setEditUser(null)}>Cancel</Button><Button variant="primary" onClick={requestSaveRole} disabled={editTargetIsTeam}>Save role</Button></>}
      >
        {editTargetIsTeam ? (
          <p className="soft" style={{ fontSize: 13, marginBottom: 6 }}>opndoor admin is the only role for internal staff. To move someone to a partner, they must be re-invited under that partner.</p>
        ) : (
          <Field label="Role">
            <RoleOptions options={editRoleOptions} selected={editRole} onSelect={setEditRole} />
          </Field>
        )}
        {!editTargetIsTeam && (
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, marginTop: 14 }}>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>Recent changes</div>
            {editAudit.length > 0 ? (
              <ul className="pm-audit">
                {editAudit.map((e, i) => (
                  <li key={i} className="pm-audit__row">
                    <span className="pm-audit__field">{AUDIT_LABEL[e.action] ?? e.action}</span>
                    <span className="pm-audit__delta">{e.oldValue} → <b>{e.newValue}</b></span>
                    <span className="pm-audit__meta">{e.actor} · {dmy(e.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--ink-mute)', margin: 0 }}>No changes recorded yet. Role changes, deactivations and 2FA resets for this user will appear here.</p>
            )}
          </div>
        )}
      </Modal>

      {/* CONFIRM (role change / deactivate / reactivate / reset 2FA) */}
      <Modal
        open={!!confirm}
        onClose={() => !busy && setConfirm(null)}
        width={440}
        title={confirm?.title ?? ''}
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button><Button variant="primary" className={confirm?.danger ? 'btn--danger' : undefined} onClick={runConfirm} disabled={busy}>{busy ? 'Working…' : confirm?.confirmLabel}</Button></>}
      >
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.55 }}>{confirm?.body}</p>
      </Modal>
    </>
  );
}
