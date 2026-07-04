/* =====================================================================
   Partners — the top of the hierarchy (opndoor admin only, enforced by the
   route guard). Lists every partner with users/agencies/branches/apps and
   status, drills into a partner's users, and onboards / amends partners
   (including their per-partner commission rates) via the add/manage modal.
   ===================================================================== */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addPartner, getPartner, getPartners, getReferrerLeaderboardMode, orgCounts, setReferrerLeaderboardMode, updatePartnerSettings, getPartnerAudit, type LeaderboardMode, type PartnerAuditEntry, type PartnerSettingsInput, type PartnerStatus } from '@/data';
import { useSession } from '@/session/SessionContext';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Card, CardHead } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Pill, type PillVariant } from '@/components/ui/Pill';
import { Tag } from '@/components/ui/Tag';
import { useToast } from '@/components/ui/Toast';
import '@/components/ui/opbar.css';
import './PartnerManagement.css';

const STATUS_PILL: Record<PartnerStatus, [string, PillVariant]> = {
  active: ['Active', 'deed'],
  onboarding: ['Onboarding', 'warn'],
  paused: ['Paused', 'muted'],
};
const initials = (n: string) => n.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const asPct = (frac: number | undefined, fallback: number) => Math.round((frac != null ? frac : fallback) * 100);

const AUDIT_LABEL: Record<string, string> = {
  partner_rate: 'Partner commission', agent_rate: 'Agent commission',
  status: 'Status', live_from: 'Live from', name: 'Name',
  referrer_leaderboard: 'Referrer leaderboard',
};
const auditField = (f: string) => AUDIT_LABEL[f] ?? f;

const LB_LABEL: Record<LeaderboardMode, string> = {
  full: 'Full (rankings and fees)',
  rankings: 'Rankings only (no fees)',
  private: 'Private (own performance only)',
};
// Friendly audit values for the leaderboard field (raw values are full/rankings/private).
const LB_SHORT: Record<string, string> = { full: 'Full', rankings: 'Rankings only', private: 'Private' };
const auditValue = (f: string, v: string) => (f === 'referrer_leaderboard' ? (LB_SHORT[v] ?? v) : v);
const dmy = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

interface RateChange { label: string; from: string; to: string; }

export function PartnerManagement() {
  usePageMeta('partners', 'Partners', ['Home', 'Administration', 'Partners']);
  const navigate = useNavigate();
  const toast = useToast();
  const { refresh: refreshData } = useSession();
  const [, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [since, setSince] = useState('');
  const [status, setStatus] = useState<PartnerStatus>('active');
  const [partnerRate, setPartnerRate] = useState('25');
  const [agentRate, setAgentRate] = useState('10');
  const [lbMode, setLbMode] = useState<LeaderboardMode>('full'); // #88 referrer leaderboard visibility
  const [audit, setAudit] = useState<PartnerAuditEntry[]>([]);
  const [saving, setSaving] = useState(false);
  // Pending rate change awaiting confirmation (current -> new), or null.
  const [confirm, setConfirm] = useState<{ input: PartnerSettingsInput; changes: RateChange[] } | null>(null);

  const partners = getPartners();

  function openAdd() {
    setEditingId(null);
    setName('');
    setSince('');
    setStatus('active');
    setPartnerRate('25');
    setAgentRate('10');
    setAudit([]);
    setConfirm(null);
    setOpen(true);
  }
  function openEdit(id: string) {
    const p = getPartner(id);
    if (!p) return;
    setEditingId(id);
    setName(p.name);
    setSince(p.since || '');
    setStatus(p.status || 'active');
    setPartnerRate(String(asPct(p.partnerRate, 0.25)));
    setAgentRate(String(asPct(p.agentRate, 0.1)));
    setLbMode(getReferrerLeaderboardMode(id));
    setConfirm(null);
    setAudit([]);
    getPartnerAudit(id).then(setAudit).catch(() => setAudit([]));
    setOpen(true);
  }

  // #88 The referrer-leaderboard setting saves immediately (not via the rate save,
  // which has a rate-confirmation early-return). Same governed RPC + audit.
  async function changeLbMode(next: LeaderboardMode) {
    if (!editingId) return;
    const prev = lbMode;
    setLbMode(next);
    try {
      await setReferrerLeaderboardMode(editingId, next);
      await refreshData();
      getPartnerAudit(editingId).then(setAudit).catch(() => { /* keep prior */ });
      toast('Referrer leaderboard visibility updated.');
    } catch (e) {
      setLbMode(prev);
      toast(e instanceof Error ? e.message : 'Could not update the setting.');
    }
  }

  function readRate(v: string, fallback: number): number {
    const n = parseFloat(v);
    if (isNaN(n) || n < 0) return fallback;
    return Math.min(100, n) / 100;
  }

  // Persist an edit (already confirmed for rate changes) and re-hydrate.
  async function applyUpdate(id: string, input: PartnerSettingsInput) {
    setSaving(true);
    try {
      await updatePartnerSettings(id, input);
      await refreshData(); // live mode: re-read the partner (and its new live rate)
      toast(`Updated ${input.name}. New applications will use ${Math.round(input.partnerRate * 100)}% partner / ${Math.round(input.agentRate * 100)}% agent; existing applications keep the rate recorded when they were created.`);
      setConfirm(null);
      setOpen(false);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the partner.');
    } finally {
      setSaving(false);
    }
  }

  function save() {
    if (!name.trim() || saving) return;
    const pr = readRate(partnerRate, 0.25);
    const ar = readRate(agentRate, 0.1);
    if (editingId) {
      const cur = getPartner(editingId);
      if (!cur) return;
      const input: PartnerSettingsInput = { name: name.trim(), status, since, partnerRate: pr, agentRate: ar };
      // A rate change needs explicit confirmation (current -> new), since it sets
      // the rate for new applications going forward.
      const changes: RateChange[] = [];
      if (cur.partnerRate !== pr) changes.push({ label: 'Partner commission', from: `${asPct(cur.partnerRate, 0.25)}%`, to: `${Math.round(pr * 100)}%` });
      if (cur.agentRate !== ar) changes.push({ label: 'Agent commission', from: `${asPct(cur.agentRate, 0.1)}%`, to: `${Math.round(ar * 100)}%` });
      if (changes.length) {
        setConfirm({ input, changes });
        return;
      }
      void applyUpdate(editingId, input);
    } else {
      const rec = addPartner({ name: name.trim(), since: since || undefined, status, partnerRate: pr, agentRate: ar });
      toast(`Partner "${rec.name}" created at ${Math.round(pr * 100)}% partner / ${Math.round(ar * 100)}% agent. Add users, agencies and branches under it next.`);
      setOpen(false);
      refresh();
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="rec-eyebrow"><span className="opx">opndoor</span> · internal admin</div>
          <h1 className="page-head__title" style={{ marginTop: 10 }}>Partners</h1>
          <p className="page-head__sub">Every partner company on the portal. A partner sits at the top of the hierarchy, with its own users, agencies, branches and applications beneath it. Click a partner to manage its users.</p>
        </div>
        <div className="page-head__actions">
          <Button variant="primary" size="sm" onClick={openAdd}><Icon name="plus" /> Add partner</Button>
        </div>
      </div>

      <div className="card opbar">
        <Icon name="shield" />
        <span>Visible to <b>opndoor admins</b> only. Partners never see each other; each partner only sees its own data.</span>
      </div>

      <Card>
        <CardHead
          title="All partners"
          sub={`${partners.length} partner ${partners.length === 1 ? 'company' : 'companies'}`}
          actions={<Button variant="quiet" size="sm" to="/users" arrow>All users · all partners</Button>}
        />
        <div className="table-wrap">
          <table className="dt ptable">
            <thead>
              <tr>
                <th>Partner</th>
                <th style={{ textAlign: 'right' }}>Users</th>
                <th style={{ textAlign: 'right' }}>Agencies</th>
                <th style={{ textAlign: 'right' }}>Branches</th>
                <th style={{ textAlign: 'right' }}>Applications</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => {
                const c = orgCounts(p.id);
                const sp = STATUS_PILL[p.status] || STATUS_PILL.active;
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="pco">
                        <span className="pco__logo">{initials(p.name)}</span>
                        <div>
                          <div className="pco__name">{p.name}{p.primary && <> <Tag variant="primary">Primary</Tag></>}</div>
                          <div className="pco__since">Live from {p.since || '—'} · Partner {asPct(p.partnerRate, 0.25)}% / Agent {asPct(p.agentRate, 0.1)}%</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}><span className="pnum">{p.users}</span></td>
                    <td style={{ textAlign: 'right' }}><span className="pnum">{c.agencies}</span></td>
                    <td style={{ textAlign: 'right' }}><span className="pnum">{c.branches}</span></td>
                    <td style={{ textAlign: 'right' }}><span className="pnum">{p.apps.toLocaleString('en-GB')}</span></td>
                    <td><Pill variant={sp[1]}>{sp[0]}</Pill></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <Button variant="ghost" size="sm" onClick={() => navigate(`/users?partner=${encodeURIComponent(p.id)}`)}>Users</Button>{' '}
                      <Button variant="primary" size="sm" onClick={() => openEdit(p.id)}>Manage</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editingId ? `Manage ${getPartner(editingId)?.name ?? ''}` : 'Add partner'}
        sub={editingId ? "Adjust this partner’s details and commission. Rate changes apply to new applications from now on." : 'Onboard a new partner company. Users, agencies and branches can be added under it afterwards.'}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create partner'}</Button></>}
      >
        <Field label="Partner company name" htmlFor="pm-name"><input id="pm-name" type="text" placeholder="e.g. PrimeLocation" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Live from" htmlFor="pm-since" hint="Optional"><input id="pm-since" type="month" value={since} onChange={(e) => setSince(e.target.value)} /></Field>
        <Field label="Status" htmlFor="pm-status">
          <select id="pm-status" value={status} onChange={(e) => setStatus(e.target.value as PartnerStatus)}>
            <option value="active">Active</option>
            <option value="onboarding">Onboarding</option>
            <option value="paused">Paused</option>
          </select>
        </Field>
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 2 }}>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 14, marginBottom: 3 }}>Commission</div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-mute)', marginBottom: 12 }}>
            Each a share of the guarantor fee (one month's rent). These are the rates for <b>new applications from now on</b>. Applications already created keep the rate recorded when they were created, so past settlements and reports never change.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Partner commission %" htmlFor="pm-partner-rate"><input id="pm-partner-rate" type="number" step="0.5" min="0" max="100" placeholder="25" value={partnerRate} onChange={(e) => setPartnerRate(e.target.value)} /></Field>
            <Field label="Agent commission %" htmlFor="pm-agent-rate"><input id="pm-agent-rate" type="number" step="0.5" min="0" max="100" placeholder="10" value={agentRate} onChange={(e) => setAgentRate(e.target.value)} /></Field>
          </div>
        </div>

        {/* #88 Referrer leaderboard visibility (per-partner policy, saves immediately). */}
        {editingId && (
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 16 }}>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 14, marginBottom: 3 }}>Referrer leaderboard</div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-mute)', marginBottom: 12 }}>
              What referrers at this partner see on the League Referrers tab. Commission is never shown to referrers.
            </div>
            <Field label="Visibility" htmlFor="pm-lb-mode">
              <select id="pm-lb-mode" value={lbMode} onChange={(e) => void changeLbMode(e.target.value as LeaderboardMode)}>
                {(Object.keys(LB_LABEL) as LeaderboardMode[]).map((m) => <option key={m} value={m}>{LB_LABEL[m]}</option>)}
              </select>
            </Field>
          </div>
        )}

        {editingId && (
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 16 }}>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Recent changes</div>
            {audit.length > 0 ? (
              <ul className="pm-audit">
                {audit.map((e, i) => (
                  <li key={i} className="pm-audit__row">
                    <span className="pm-audit__field">{auditField(e.field)}</span>
                    <span className="pm-audit__delta">{auditValue(e.field, e.oldValue)} → <b>{auditValue(e.field, e.newValue)}</b></span>
                    <span className="pm-audit__meta">{e.actor} · {dmy(e.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--ink-mute)', margin: 0 }}>No changes recorded yet. Edits to this partner's name, status, go-live date or commission rates will appear here.</p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        width={460}
        title="Confirm commission change"
        sub="This sets the rate for new applications from now on. Existing applications keep the rate recorded when they were created, so past settlements and reports are unaffected."
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)} disabled={saving}>Back</Button><Button variant="primary" onClick={() => confirm && editingId && applyUpdate(editingId, confirm.input)} disabled={saving}>{saving ? 'Saving…' : 'Confirm change'}</Button></>}
      >
        <ul className="pm-confirm">
          {confirm?.changes.map((c) => (
            <li key={c.label} className="pm-confirm__row">
              <span className="pm-confirm__label">{c.label}</span>
              <span className="pm-confirm__delta"><span className="pm-confirm__from">{c.from}</span> → <b className="pm-confirm__to">{c.to}</b></span>
            </li>
          ))}
        </ul>
        <p style={{ fontSize: 12.5, color: 'var(--ink-mute)', marginTop: 4 }}>This change is recorded in the partner's audit trail.</p>
      </Modal>
    </>
  );
}
