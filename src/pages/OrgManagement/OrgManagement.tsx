/* =====================================================================
   Agencies & branches — the partner organisation hierarchy. Expandable
   agencies, live search with highlighting, drill-through figures to the
   applications behind them, the add-agency/add-branch modals, the
   Management-only commission columns (per-partner rates), and the opndoor
   admin partner selector. View for all roles; canonical editing is admin.

   Every mutation here PERSISTS through a gated RPC (Supabase mode) and then
   re-hydrates from the server, so nothing an admin saves can vanish on the
   next hydration. Admin-created records land confirmed; management-created
   land pending_review. In mock/test mode the same edits apply locally.
   ===================================================================== */
import { useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ALL_PARTNERS, addContactLive, createAgencyLive, createBranchLive, effectivePrimary, findAgency,
  getAgencies, getPartners, getRatesFor, removeContactLive, setPrimaryLive, updateContactLive,
  type Agency, type AgentContact, type Branch,
} from '@/data';
import { useSession } from '@/session/SessionContext';
import { usePageMeta } from '@/components/layout/pageMeta';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { PartnerSelect } from '@/components/ui/Select';
import './OrgManagement.css';

const agencyId = (a: Agency) => `${a.partner || 'rightmove'}:${a.name}`;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** An inline, consequence-aware confirmation rendered inside the contacts modal. */
interface CtConfirm {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  success?: string;
  /** Whether to re-hydrate after the action (mutations yes, a pure discard no). */
  refreshAfter: boolean;
  run: () => Promise<void>;
}

function highlight(name: string, q: string): ReactNode {
  if (!q) return name;
  const i = name.toLowerCase().indexOf(q);
  if (i === -1) return name;
  return (
    <>
      {name.slice(0, i)}
      <mark className="hl">{name.slice(i, i + q.length)}</mark>
      {name.slice(i + q.length)}
    </>
  );
}

function feesOf(item: Agency | Branch, isAgency: boolean): number {
  if (item.fees != null) return item.fees;
  if (isAgency && (item as Agency).branches) return (item as Agency).branches.reduce((s, b) => s + feesOf(b, false), 0);
  return Math.round((item.referrals || 0) * 0.78 * 2180);
}
function fmtK(n: number): string {
  if (n >= 1e6) return `£${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `£${Math.round(n / 1e3)}k`;
  return `£${Math.round(n)}`;
}

const goIcon = <span className="statlink__go"><Icon name="arrowRight" strokeWidth={2.2} /></span>;
const ctInitials = (n: string) => n.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

/** The effective-primary-contact summary line shown under an agency or branch name. */
function ContactSummary({ agency, branch, canManage, onManage }: { agency: Agency; branch: Branch | null; canManage: boolean; onManage: () => void }) {
  const ep = effectivePrimary(agency, branch);
  const manageBtn = canManage ? (
    <button className="contact-manage" onClick={(e) => { e.stopPropagation(); onManage(); }}>Manage</button>
  ) : null;
  if (!ep.contact) {
    return <div className="contact-line"><Icon name="mail" /><span className="cl-none">No agent contact</span>{manageBtn}</div>;
  }
  return (
    <div className="contact-line">
      <Icon name="mail" />
      <span><b>{ep.contact.name}</b> · {ep.contact.email}</span>
      {branch && ep.inherited && <span className="cl-inherit">(agency default)</span>}
      {manageBtn}
    </div>
  );
}

export function OrgManagement() {
  usePageMeta('org', 'Agencies & branches', ['Home', 'Administration', 'Agencies & branches']);
  const { role, partnerScope, selectedPartner, setSelectedPartner, refresh: refreshData } = useSession();
  const toast = useToast();

  const [, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [openSet, setOpenSet] = useState<Set<string>>(() => new Set(getAgencies(ALL_PARTNERS).filter((a) => a.open).map(agencyId)));

  // add-agency modal (+ its required default contact)
  const [agencyOpen, setAgencyOpen] = useState(false);
  const [agencyName, setAgencyName] = useState('');
  const [agencyGroup, setAgencyGroup] = useState('');
  const [agencyContact, setAgencyContact] = useState({ name: '', email: '', phone: '' });
  // add-branch modal (+ its optional own contact)
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [branchArea, setBranchArea] = useState('');
  const [branchAgency, setBranchAgency] = useState('');
  const [branchContact, setBranchContact] = useState({ name: '', email: '', phone: '' });

  // contacts modal (agent contacts on an agency or branch). Editable by Management too.
  const canManageOrg = role === 'superadmin' || role === 'management';
  const canManageContacts = role === 'superadmin' || role === 'management';
  const [ctOpen, setCtOpen] = useState(false);
  const [ctAgencyName, setCtAgencyName] = useState('');
  const [ctBranchName, setCtBranchName] = useState<string | null>(null);
  const [ctEditIndex, setCtEditIndex] = useState<number | null>(null);
  const [ctName, setCtName] = useState('');
  const [ctRole, setCtRole] = useState('');
  const [ctEmail, setCtEmail] = useState('');
  const [ctPhone, setCtPhone] = useState('');
  const [ctPrimary, setCtPrimary] = useState(false);
  const [ctConfirm, setCtConfirm] = useState<CtConfirm | null>(null);

  const rates = getRatesFor(partnerScope);
  const isMgmt = role === 'management';
  const q = query.trim().toLowerCase();
  const pool = getAgencies(partnerScope);

  const partnerPoolForBranch = getAgencies(partnerScope);

  // Resolve the contacts-modal owner fresh each render (reflects mutations + re-hydration).
  const ctAgency = ctOpen ? findAgency(ctAgencyName) ?? null : null;
  const ctBranch = ctBranchName && ctAgency ? ctAgency.branches.find((b) => b.name === ctBranchName) ?? null : null;
  const ctContacts: AgentContact[] = (ctBranchName ? ctBranch?.contacts : ctAgency?.contacts) ?? [];
  const ownerLabel = ctBranchName ? ctBranchName : ctAgencyName;

  // Is the contact form holding unsaved input? (drives the item-58 close guard).
  const ctEditing = ctEditIndex !== null ? ctContacts[ctEditIndex] : null;
  const formHasContent = !!(ctName.trim() || ctEmail.trim() || ctRole.trim() || ctPhone.trim());
  const formDirty = ctEditIndex === null
    ? (formHasContent || ctPrimary)
    : (!!ctEditing && (
        ctName !== ctEditing.name || ctEmail !== ctEditing.email ||
        (ctRole || '') !== (ctEditing.role || '') || (ctPhone || '') !== (ctEditing.phone || '') ||
        ctPrimary !== !!ctEditing.primary));

  function openContacts(agencyName: string, branchName: string | null) {
    setCtAgencyName(agencyName);
    setCtBranchName(branchName);
    setCtConfirm(null);
    resetContactForm();
    setCtOpen(true);
  }
  function resetContactForm() {
    setCtEditIndex(null);
    setCtName('');
    setCtRole('');
    setCtEmail('');
    setCtPhone('');
    setCtPrimary(false);
  }
  function startEditContact(index: number) {
    const c = ctContacts[index];
    if (!c) return;
    setCtConfirm(null);
    setCtEditIndex(index);
    setCtName(c.name);
    setCtRole(c.role || '');
    setCtEmail(c.email);
    setCtPhone(c.phone || '');
    setCtPrimary(!!c.primary);
  }

  /** Run a persisting mutation: apply, re-hydrate from the server, toast. */
  async function runOrg(fn: () => Promise<void>, success: string, after?: () => void): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await refreshData();
      refresh();
      after?.();
      toast(success);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  /** Run the inline confirm's action (mutations re-hydrate; a discard does not). */
  async function runCtConfirm(): Promise<void> {
    if (!ctConfirm || busy) return;
    const spec = ctConfirm;
    setBusy(true);
    try {
      await spec.run();
      if (spec.refreshAfter) { await refreshData(); refresh(); }
      if (spec.success) toast(spec.success);
      setCtConfirm(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function submitContact() {
    if (!ctAgency || busy) return;
    const name = ctName.trim();
    const email = ctEmail.trim();
    if (!name || !email) return;
    if (!EMAIL_RE.test(email)) { toast('Enter a valid contact email.'); return; }
    const rec: AgentContact = { name, role: ctRole.trim(), email, phone: ctPhone.trim(), primary: ctPrimary };
    if (ctEditIndex !== null) {
      const idx = ctEditIndex;
      const orig = ctContacts[idx];
      const otherPrimary = ctContacts.some((c, i) => i !== idx && c.primary);
      // Item 56: preserve primary through edits; warn before leaving no primary.
      if (orig?.primary && !ctPrimary && !otherPrimary) {
        setCtConfirm({
          title: 'Leave no primary contact?',
          body: <><b>{ownerLabel}</b> must keep a primary contact for deed delivery. If you save without one, a remaining contact is promoted automatically. To move it deliberately, set another contact as primary instead.</>,
          confirmLabel: 'Save anyway', danger: true, success: 'Contact updated.', refreshAfter: true,
          run: async () => { await updateContactLive(ctAgency, ctBranch, idx, orig?.id, rec); resetContactForm(); },
        });
        return;
      }
      void runOrg(() => updateContactLive(ctAgency, ctBranch, idx, orig?.id, rec), 'Contact updated.', resetContactForm);
    } else {
      void runOrg(() => addContactLive(ctAgency, ctBranch, rec), 'Contact added.', resetContactForm);
    }
  }

  /** The consequence text for removing the contact at index (item 57). */
  function removeConsequence(index: number): ReactNode {
    const c = ctContacts[index];
    const isOnly = ctContacts.length === 1;
    const others = ctContacts.filter((_, i) => i !== index);
    if (!ctBranchName) {
      if (isOnly) {
        const inheriting = (ctAgency?.branches ?? []).filter((b) => !(b.contacts && b.contacts.length)).length;
        return <>This is <b>{ctAgencyName}</b>'s only contact. {inheriting} {inheriting === 1 ? 'branch inherits' : 'branches inherit'} it, so {inheriting === 1 ? 'its' : 'their'} deeds will have no delivery address until you add another. This cannot be undone.</>;
      }
      if (c.primary) return <><b>{c.name}</b> is <b>{ctAgencyName}</b>'s primary contact. Removing them promotes <b>{others[0].name}</b> to primary. This cannot be undone.</>;
      return <>Remove <b>{c.name}</b> from <b>{ctAgencyName}</b>? This cannot be undone.</>;
    }
    if (isOnly) {
      const agDefault = effectivePrimary(ctAgency, null).contact;
      return agDefault
        ? <>This is <b>{ctBranchName}</b>'s only contact. The branch will fall back to the <b>{ctAgencyName}</b> agency default (<b>{agDefault.name}</b>). This cannot be undone.</>
        : <>This is <b>{ctBranchName}</b>'s only contact, and <b>{ctAgencyName}</b> has no contact either, so deeds for this branch will have no delivery address. This cannot be undone.</>;
    }
    if (c.primary) return <><b>{c.name}</b> is this branch's primary contact. Removing them promotes <b>{others[0].name}</b> to primary. This cannot be undone.</>;
    return <>Remove <b>{c.name}</b> from <b>{ctBranchName}</b>? This cannot be undone.</>;
  }

  function askRemoveContact(index: number) {
    if (!ctAgency) return;
    const c = ctContacts[index];
    if (!c) return;
    setCtConfirm({
      title: `Remove ${c.name}?`,
      body: removeConsequence(index),
      confirmLabel: 'Remove contact', danger: true, success: 'Contact removed.', refreshAfter: true,
      run: async () => { await removeContactLive(ctAgency, ctBranch, index, c.id); resetContactForm(); },
    });
  }

  function makePrimary(index: number) {
    if (!ctAgency) return;
    const c = ctContacts[index];
    void runOrg(() => setPrimaryLive(ctAgency, ctBranch, index, c?.id), 'Primary contact updated.');
  }

  // Item 58: pressing Done (or closing) must not silently discard a part-filled form.
  function requestCloseContacts() {
    if (busy) return;
    if (ctConfirm) return; // resolve the open confirmation first
    if (formDirty) {
      setCtConfirm({
        title: 'Discard unsaved contact?',
        body: <>You have entered contact details that have not been saved. Closing now will discard them.</>,
        confirmLabel: 'Discard', danger: true, refreshAfter: false,
        run: async () => { resetContactForm(); setCtOpen(false); },
      });
      return;
    }
    setCtOpen(false);
  }

  function toggle(id: string) {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onHeadClick(e: MouseEvent, id: string) {
    const target = e.target as HTMLElement;
    if (target.closest('.statlink') || target.closest('[data-stop]')) return;
    toggle(id);
  }

  const agencyEmailOk = EMAIL_RE.test(agencyContact.email.trim());
  const canSaveAgency = !!agencyName.trim() && agencyEmailOk && !busy;
  function saveAgency() {
    if (!canSaveAgency) return;
    void runOrg(
      () => createAgencyLive({
        name: agencyName.trim(), group: agencyGroup.trim() || undefined,
        contactEmail: agencyContact.email.trim(), contactName: agencyContact.name.trim() || undefined, contactPhone: agencyContact.phone.trim() || undefined,
      }, partnerScope),
      'Agency added.',
      () => setAgencyOpen(false),
    );
  }

  function openAddBranch(name?: string) {
    setBranchName('');
    setBranchArea('');
    setBranchContact({ name: '', email: '', phone: '' });
    setBranchAgency(name || partnerPoolForBranch[0]?.name || '');
    setBranchOpen(true);
  }
  const branchEmailProvided = !!branchContact.email.trim();
  const branchEmailOk = EMAIL_RE.test(branchContact.email.trim());
  const canSaveBranch = !!branchName.trim() && !!branchAgency && (!branchEmailProvided || branchEmailOk) && !busy;
  function saveBranch() {
    if (!canSaveBranch) return;
    const agency = findAgency(branchAgency);
    if (!agency) { toast('Select a parent agency.'); return; }
    void runOrg(
      () => createBranchLive(agency, {
        name: branchName.trim(), area: branchArea.trim() || undefined,
        contactEmail: branchContact.email.trim() || undefined, contactName: branchContact.name.trim() || undefined, contactPhone: branchContact.phone.trim() || undefined,
      }),
      'Branch added.',
      () => setBranchOpen(false),
    );
  }

  const eyebrow = role === 'superadmin' ? 'opndoor admin' : role === 'management' ? 'Management' : 'Organisation';
  const roleNote: ReactNode =
    role === 'superadmin' ? <>As an <b>opndoor admin</b> you have full control: add, edit and reorganise agencies and branches, and sync the hierarchy with HubSpot.</>
      : role === 'management' ? <>You can view every agency and branch across the estate and add new ones. Editing existing records and HubSpot sync are handled by <b>opndoor</b>.</>
        : <>You can view every agency and branch. Adding and editing records is handled by your management team and <b>opndoor</b>.</>;

  // Filtered, with expand-all while searching (mirrors org-management.html).
  const shownAgencies = pool
    .map((a) => {
      const agencyMatch = a.name.toLowerCase().includes(q);
      const branches = a.branches.filter((b) => !q || agencyMatch || b.name.toLowerCase().includes(q));
      return { a, agencyMatch, branches };
    })
    .filter(({ agencyMatch, branches }) => !(q && !agencyMatch && branches.length === 0));

  return (
    <>
      <div className="page-head">
        <div>
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="page-head__title" style={{ marginTop: 10 }}>Agencies &amp; branches</h1>
          <p className="page-head__sub">Manage the partner organisation hierarchy. Search to find an agency or branch, expand to see branches, or click any figure to view the applications behind it.</p>
        </div>
        <div className="page-head__actions">
          {role === 'superadmin' && (
            <PartnerSelect
              ariaLabel="Partner"
              value={selectedPartner}
              onChange={setSelectedPartner}
              options={[{ value: ALL_PARTNERS, label: 'All partners' }, ...getPartners().map((p) => ({ value: p.id, label: p.name }))]}
            />
          )}
          <Button variant="ghost" size="sm"><Icon name="download" /> Export</Button>
          {canManageOrg && (
            <Button variant="primary" size="sm" onClick={() => { setAgencyName(''); setAgencyGroup(''); setAgencyContact({ name: '', email: '', phone: '' }); setAgencyOpen(true); }}><Icon name="plus" /> Add agency</Button>
          )}
        </div>
      </div>

      <div className="rolenote" style={{ marginBottom: 18 }}>
        <Icon name="shield" />
        <span>{roleNote}</span>
      </div>

      <div className={`org-search${query.trim() ? ' has-q' : ''}`}>
        <Icon name="search" />
        <input type="text" placeholder="Search agencies or branches" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="org-search__clear" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="x" size={16} /></button>
      </div>

      <div className="org">
        {shownAgencies.map(({ a, branches }) => {
          const id = agencyId(a);
          const open = q ? true : openSet.has(id);
          const fees = feesOf(a, true);
          const meta = `${a.group ? `${a.group} · ` : ''}${a.branches.length} ${a.branches.length === 1 ? 'branch' : 'branches'}`;
          return (
            <div className={`agency${open ? ' is-open' : ''}`} key={id}>
              <div className="agency__head" onClick={(e) => onHeadClick(e, id)}>
                <span className="agency__chev"><Icon name="chevronRight" size={18} strokeWidth={2.2} /></span>
                <span className="agency__ic"><Icon name="org" /></span>
                <div className="agency__txt">
                  <div className="agency__name">{highlight(a.name, q)}</div>
                  <div className="agency__meta">{meta}</div>
                  <ContactSummary agency={a} branch={null} canManage={canManageContacts} onManage={() => openContacts(a.name, null)} />
                </div>
                <Link className="statlink statlink--agency" to={`/applications?agency=${encodeURIComponent(a.name)}`} title={`View all applications for ${a.name}`}>
                  <div className="agency__stat"><div className="n">{a.referrals}</div><div className="l">Referrals</div></div>
                  <div className="agency__stat"><div className="n">{fmtK(fees)}</div><div className="l">Fees collected</div></div>
                  {isMgmt && <div className="agency__stat"><div className="n">{fmtK(fees * rates.partner)}</div><div className="l">Your commission</div></div>}
                  {isMgmt && <div className="agency__stat"><div className="n">{fmtK(fees * rates.agent)}</div><div className="l">Agent comm.</div></div>}
                  {goIcon}
                </Link>
                {role === 'superadmin' && (
                  <div className="agency__actions" data-stop>
                    <button className="iconbtn iconbtn--sm" title="Edit"><Icon name="edit" /></button>
                  </div>
                )}
              </div>
              <div className="branches">
                {branches.map((b) => {
                  const bFees = feesOf(b, false);
                  return (
                    <div className="branch" key={b.name}>
                      <span className="branch__line">│</span>
                      <span className="branch__ic"><Icon name="home" /></span>
                      <div className="branch__txt">
                        <div className="branch__name">{highlight(b.name, q)}</div>
                        <div className="branch__meta">{b.area}</div>
                        <ContactSummary agency={a} branch={b} canManage={canManageContacts} onManage={() => openContacts(a.name, b.name)} />
                      </div>
                      <Link className="statlink statlink--branch" to={`/applications?branch=${encodeURIComponent(b.name)}`} title={`View applications for ${b.name}`}>
                        <div className="branch__stat"><b>{b.referrals}</b>referrals</div>
                        <div className="branch__stat"><b>{fmtK(bFees)}</b>fees collected</div>
                        {isMgmt && <div className="branch__stat"><b>{fmtK(bFees * rates.partner)}</b>your comm.</div>}
                        {isMgmt && <div className="branch__stat"><b>{fmtK(bFees * rates.agent)}</b>agent comm.</div>}
                        {goIcon}
                      </Link>
                    </div>
                  );
                })}
                {!q && canManageOrg && (
                  <div className="branch__add">
                    <Button variant="ghost" size="sm" onClick={() => openAddBranch(a.name)}><Icon name="plus" /> Add branch</Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className={`org-empty${shownAgencies.length ? '' : ' is-shown'}`}>No agencies or branches match your search.</div>

      {/* ADD AGENCY */}
      <Modal
        open={agencyOpen}
        onClose={() => { if (!busy) setAgencyOpen(false); }}
        title="Add agency"
        sub="Create a new agency in the hierarchy. A default contact is required so deeds and the bordereau resolve to someone reachable."
        footer={<><Button variant="ghost" onClick={() => setAgencyOpen(false)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={saveAgency} disabled={!canSaveAgency}>{busy ? 'Saving…' : 'Save agency'}</Button></>}
      >
        <Field label="Agency name" htmlFor="agency-name"><input id="agency-name" type="text" placeholder="e.g. Riverside Lettings" autoComplete="off" value={agencyName} onChange={(e) => setAgencyName(e.target.value)} /></Field>
        <Field label="Group / network" htmlFor="agency-group" hint="Optional"><input id="agency-group" type="text" placeholder="e.g. ABC group" autoComplete="off" value={agencyGroup} onChange={(e) => setAgencyGroup(e.target.value)} /></Field>
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, marginTop: 6 }}>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 13.5, marginBottom: 4 }}>Default agency contact</div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-mute)', margin: '0 0 12px' }}>Its branches inherit this contact unless they have their own.</p>
          <div className="form-grid">
            <Field span2 label={<>Contact email <span className="req" aria-hidden="true">*</span></>} htmlFor="agency-cemail"><input id="agency-cemail" type="email" placeholder="agent@agency.co.uk" autoComplete="off" value={agencyContact.email} onChange={(e) => setAgencyContact((c) => ({ ...c, email: e.target.value }))} /></Field>
            <Field label="Contact name" htmlFor="agency-cname" hint="Optional"><input id="agency-cname" type="text" placeholder="e.g. Jordan Blake" autoComplete="off" value={agencyContact.name} onChange={(e) => setAgencyContact((c) => ({ ...c, name: e.target.value }))} /></Field>
            <Field label="Contact phone" htmlFor="agency-cphone" hint="Optional"><input id="agency-cphone" type="tel" placeholder="020 7946 0000" autoComplete="off" value={agencyContact.phone} onChange={(e) => setAgencyContact((c) => ({ ...c, phone: e.target.value }))} /></Field>
          </div>
        </div>
      </Modal>

      {/* ADD BRANCH */}
      <Modal
        open={branchOpen}
        onClose={() => { if (!busy) setBranchOpen(false); }}
        title="Add branch"
        sub="Add a branch to an agency. A branch with no contact of its own inherits the agency default."
        footer={<><Button variant="ghost" onClick={() => setBranchOpen(false)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={saveBranch} disabled={!canSaveBranch}>{busy ? 'Saving…' : 'Save branch'}</Button></>}
      >
        <Field label="Branch name" htmlFor="branch-name"><input id="branch-name" type="text" placeholder="e.g. Notting Hill" autoComplete="off" value={branchName} onChange={(e) => setBranchName(e.target.value)} /></Field>
        <Field label="Postcode / area" htmlFor="branch-area" hint="Optional"><input id="branch-area" type="text" placeholder="e.g. W11" autoComplete="off" value={branchArea} onChange={(e) => setBranchArea(e.target.value)} /></Field>
        <Field label="Parent agency" htmlFor="branch-agency">
          <select id="branch-agency" value={branchAgency} onChange={(e) => setBranchAgency(e.target.value)}>
            {partnerPoolForBranch.map((a) => <option key={agencyId(a)} value={a.name}>{a.name}</option>)}
          </select>
        </Field>
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, marginTop: 6 }}>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 13.5, marginBottom: 4 }}>Branch contact <span style={{ fontWeight: 400, color: 'var(--ink-mute)' }}>(optional)</span></div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-mute)', margin: '0 0 12px' }}>Leave blank to inherit the agency default contact.</p>
          <div className="form-grid">
            <Field span2 label="Contact email" htmlFor="branch-cemail" hint="Optional"><input id="branch-cemail" type="email" placeholder="branch@agency.co.uk" autoComplete="off" value={branchContact.email} onChange={(e) => setBranchContact((c) => ({ ...c, email: e.target.value }))} /></Field>
            <Field label="Contact name" htmlFor="branch-cname" hint="Optional"><input id="branch-cname" type="text" placeholder="e.g. Sam Rivers" autoComplete="off" value={branchContact.name} onChange={(e) => setBranchContact((c) => ({ ...c, name: e.target.value }))} /></Field>
            <Field label="Contact phone" htmlFor="branch-cphone" hint="Optional"><input id="branch-cphone" type="tel" placeholder="020 7946 0000" autoComplete="off" value={branchContact.phone} onChange={(e) => setBranchContact((c) => ({ ...c, phone: e.target.value }))} /></Field>
          </div>
        </div>
      </Modal>

      {/* MANAGE AGENT CONTACTS */}
      <Modal
        open={ctOpen}
        onClose={requestCloseContacts}
        title={`${ctBranchName || ctAgencyName} contacts`}
        sub={ctBranchName ? 'Agent contacts for this branch. Who the Deed of Guarantee is sent to.' : 'Agency contacts. Used as the default for branches with no contact of their own.'}
        footer={<Button variant="primary" onClick={requestCloseContacts} disabled={busy}>Done</Button>}
      >
        {ctConfirm && (
          <div className={`ct-confirm${ctConfirm.danger ? ' is-danger' : ''}`}>
            <div className="ct-confirm__title">{ctConfirm.title}</div>
            <div className="ct-confirm__body">{ctConfirm.body}</div>
            <div className="ct-confirm__actions">
              <Button variant="ghost" size="sm" onClick={() => setCtConfirm(null)} disabled={busy}>Cancel</Button>
              <Button variant="primary" size="sm" className={ctConfirm.danger ? 'btn--danger' : undefined} onClick={runCtConfirm} disabled={busy}>{busy ? 'Working…' : ctConfirm.confirmLabel}</Button>
            </div>
          </div>
        )}

        {ctBranchName && ctContacts.length === 0 && (
          <div className="ct-inherit-note">
            {effectivePrimary(ctAgency, ctBranch).contact ? (
              <>This branch has no contact of its own, so it uses the <b>{ctAgencyName}</b> agency default (<b>{effectivePrimary(ctAgency, ctBranch).contact!.name}</b>). Add a contact below to override it for this branch.</>
            ) : (
              <>This branch has no contact of its own, and the agency has none either. Add a branch contact below, or add an agency contact to cover all its branches.</>
            )}
          </div>
        )}

        <div>
          {ctContacts.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--ink-mute)', padding: '6px 0 14px' }}>No contacts yet.</p>
          ) : (
            ctContacts.map((c, i) => (
              <div className="ct-row" key={c.id ?? i}>
                <span className="ct-av">{ctInitials(c.name)}</span>
                <div className="ct-main">
                  <div className="ct-name">{c.name}{c.primary && <span className="ct-primary">Primary</span>}</div>
                  <div className="ct-sub">{c.role ? `${c.role} · ` : ''}{c.email}{c.phone ? ` · ${c.phone}` : ''}</div>
                </div>
                <div className="ct-actions">
                  {!c.primary && <button onClick={() => makePrimary(i)} disabled={busy}>Set primary</button>}
                  <button onClick={() => startEditContact(i)} disabled={busy}>Edit</button>
                  <button onClick={() => askRemoveContact(i)} disabled={busy}>Remove</button>
                </div>
              </div>
            ))
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 6 }}>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 13.5, marginBottom: 12 }}>{ctEditIndex !== null ? 'Edit contact' : 'Add a contact'}</div>
          <div className="form-grid">
            <Field label="Name" htmlFor="ct-name"><input id="ct-name" type="text" autoComplete="off" value={ctName} onChange={(e) => setCtName(e.target.value)} /></Field>
            <Field label="Role" htmlFor="ct-role" hint="Optional"><input id="ct-role" type="text" placeholder="e.g. Branch manager" autoComplete="off" value={ctRole} onChange={(e) => setCtRole(e.target.value)} /></Field>
            <Field label="Email" htmlFor="ct-email"><input id="ct-email" type="email" autoComplete="off" value={ctEmail} onChange={(e) => setCtEmail(e.target.value)} /></Field>
            <Field label="Phone" htmlFor="ct-phone" hint="Optional"><input id="ct-phone" type="text" autoComplete="off" value={ctPhone} onChange={(e) => setCtPhone(e.target.value)} /></Field>
            <label className="field span-2" style={{ flexDirection: 'row', alignItems: 'center', gap: 9, display: 'flex' }}>
              <input type="checkbox" checked={ctPrimary} onChange={(e) => setCtPrimary(e.target.checked)} style={{ width: 'auto' }} />
              <span style={{ fontSize: 13, color: 'var(--ink-soft)', fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>Primary contact (receives the deed by default)</span>
            </label>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <Button variant="primary" size="sm" onClick={submitContact} disabled={busy}>{ctEditIndex !== null ? 'Save contact' : 'Add contact'}</Button>
            {ctEditIndex !== null && <Button variant="ghost" size="sm" onClick={resetContactForm} disabled={busy}>Cancel edit</Button>}
          </div>
        </div>
      </Modal>
    </>
  );
}
