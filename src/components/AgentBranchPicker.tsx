/* =====================================================================
   AgentBranchPicker — the two linked select-or-add fields on the new
   application form. The agent field searches existing agencies (scoped to
   the user's partner) and offers "create new agent"; once an agent is chosen,
   the branch field unlocks, filtered to that agent's branches, with "create
   new branch" on the fly.

   When an agent (agency) is created on the fly, a contact block appears to
   capture the agency-default contact (email required; name and phone optional)
   so Send-deed-to-agent and the bordereau Claim Contact resolve to something
   reachable. A newly-created branch may optionally capture its own contact;
   absent one it inherits the agency default.

   #65 Single-office agents: when the chosen agency has no branches, a default
   "Head office" branch is used automatically (inheriting the agency contact),
   so no one has to invent a junk branch. Type a branch name to override it.

   #66 opndoor admins fly-create under an explicit partner: the referral's
   commission lands under it, so the partner is shown and chosen here rather
   than resolved silently from ambient scope. Existing agencies carry their own
   partner (shown in the option), which disambiguates same-named agencies.

   Entities created here write to the client org store for the picker UI; they
   are persisted (as pending_review, or confirmed for an admin) and the contact
   captured server-side when the referral is submitted (create-referral ->
   create_referral_target).
   ===================================================================== */
import { useEffect, useRef, useState } from 'react';
import { ALL_PARTNERS, createAgencyOnTheFly, createBranchOnTheFly, findAgency, getPartners, searchAgencies, searchBranches } from '@/data';
import { useSession } from '@/session/SessionContext';
import { Icon } from '@/components/ui/Icon';
import { TypeAhead, highlightMatch, type TypeAheadOption } from '@/components/ui/TypeAhead';

const DEFAULT_BRANCH = 'Head office';

export interface AgentBranchValue {
  agency: string;
  branch: string;
  /** The agency/branch was created on the fly in this picker. */
  agencyNew: boolean;
  branchNew: boolean;
  /** Captured contact for a newly-created agency (email required when agencyNew). */
  agencyContactEmail: string;
  agencyContactName: string;
  agencyContactPhone: string;
  /** Optional contact for a newly-created branch. */
  branchContactEmail: string;
  /** The partner the referral belongs to: the chosen agency's own partner, or
      (admin fly-creation) the explicitly selected partner. '' when unresolved. */
  partner: string;
  /** #74 For a NEW agency only: has the "single-office agency?" question been
      answered? null = not yet (blocks submit); true = single office (auto Head
      office branch); false = has branches (name one). Always null for an
      existing agency, which is never asked. */
  singleOffice: boolean | null;
}

export function AgentBranchPicker({ onChange }: { onChange?: (value: AgentBranchValue) => void }) {
  const { role, partnerScope } = useSession();
  const isAdmin = role === 'superadmin';
  const [agentValue, setAgentValue] = useState('');
  const [selectedAgency, setSelectedAgency] = useState<string | null>(null);
  const [selectedAgencyPartner, setSelectedAgencyPartner] = useState<string | null>(null);
  const [agencyNew, setAgencyNew] = useState(false);
  const [branchValue, setBranchValue] = useState('');
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [branchNew, setBranchNew] = useState(false);
  // The branch was auto-defaulted to Head office because the agency has none.
  const [branchAuto, setBranchAuto] = useState(false);
  // #74 For a new agency: the answer to "Is this a single-office agency?".
  // null until answered (no default), so submit is blocked until the user picks.
  const [singleOffice, setSingleOffice] = useState<boolean | null>(null);
  const [agEmail, setAgEmail] = useState('');
  const [agName, setAgName] = useState('');
  const [agPhone, setAgPhone] = useState('');
  const [brEmail, setBrEmail] = useState('');
  // Admin fly-creation: the partner the new agency lands under.
  const [adminPartner, setAdminPartner] = useState('');
  // Names created on the fly in this picker. An on-the-fly agency also lands in
  // the client org store, so it shows up as an "existing" search hit; this set
  // keeps it flagged as new (so re-selecting it still requires a contact and
  // creates a contact-bearing record on submit).
  const createdAgencies = useRef<Set<string>>(new Set());

  // The partner the referral resolves to.
  const resolvedPartner = (() => {
    if (selectedAgency && !agencyNew) return selectedAgencyPartner ?? '';
    if (agencyNew) return isAdmin ? adminPartner : (partnerScope === ALL_PARTNERS ? '' : partnerScope);
    return partnerScope === ALL_PARTNERS ? '' : partnerScope;
  })();

  // Emit the composed value whenever anything relevant changes.
  useEffect(() => {
    onChange?.({
      agency: selectedAgency ?? '',
      branch: selectedBranch ?? '',
      agencyNew,
      branchNew,
      agencyContactEmail: agEmail.trim(),
      agencyContactName: agName.trim(),
      agencyContactPhone: agPhone.trim(),
      branchContactEmail: branchAuto ? '' : brEmail.trim(),
      partner: resolvedPartner,
      singleOffice: agencyNew ? singleOffice : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgency, selectedBranch, agencyNew, branchNew, agEmail, agName, agPhone, brEmail, branchAuto, resolvedPartner, singleOffice]);

  /** Auto-fill a "Head office" branch when the agency has no branches (#65). */
  function autoBranchIfSingleOffice(name: string) {
    const rec = findAgency(name);
    if (rec && rec.branches.length === 0) {
      setBranchValue(DEFAULT_BRANCH);
      setSelectedBranch(DEFAULT_BRANCH);
      setBranchNew(true);
      setBranchAuto(true);
      setBrEmail('');
    }
  }

  function chooseAgency(name: string, isNewArg: boolean, partner?: string) {
    // A picker-created agency stays "new" even when re-selected from the list.
    const isNew = isNewArg || createdAgencies.current.has(name.toLowerCase());
    setSelectedAgency(name);
    setSelectedAgencyPartner(partner ?? findAgency(name)?.partner ?? null);
    setAgentValue(name);
    setAgencyNew(isNew);
    setBranchValue('');
    setSelectedBranch(null);
    setBranchNew(false);
    setBranchAuto(false);
    setBrEmail('');
    setSingleOffice(null); // #74 a fresh choice is unanswered
    if (!isNew) { setAgEmail(''); setAgName(''); setAgPhone(''); }
    else if (isAdmin) setAdminPartner((p) => p || (partnerScope === ALL_PARTNERS ? '' : partnerScope));
    // #65 silent Head office default stays for EXISTING single-office agencies;
    // a NEW agency is asked explicitly (#74) rather than defaulted.
    if (!isNew) autoBranchIfSingleOffice(name);
  }

  /** #74 Answer the single-office question for a new agency. Yes auto-creates a
      self-identifying "[Agency], Head office" branch (inheriting the agency
      contact); No clears the branch so the user names one. */
  function answerSingleOffice(yes: boolean) {
    setSingleOffice(yes);
    if (yes) {
      const name = `${selectedAgency}, Head office`;
      setBranchValue(name);
      setSelectedBranch(name);
      setBranchNew(true);
      setBranchAuto(true);
      setBrEmail('');
    } else {
      setBranchValue('');
      setSelectedBranch(null);
      setBranchNew(false);
      setBranchAuto(false);
      setBrEmail('');
    }
  }

  function resetAgent(v: string) {
    setAgentValue(v);
    setSelectedAgency(null);
    setSelectedAgencyPartner(null);
    setAgencyNew(false);
    setBranchValue('');
    setSelectedBranch(null);
    setBranchNew(false);
    setBranchAuto(false);
    setSingleOffice(null);
    setAgEmail(''); setAgName(''); setAgPhone(''); setBrEmail('');
  }

  function chooseBranch(name: string, isNew: boolean) {
    setBranchValue(name);
    setSelectedBranch(name);
    setBranchNew(isNew);
    setBranchAuto(false);
    if (!isNew) setBrEmail('');
  }

  function onBranchInput(v: string) {
    setBranchValue(v);
    // Editing away from the committed branch de-selects it.
    if (v.trim().toLowerCase() !== (selectedBranch ?? '').toLowerCase()) {
      setSelectedBranch(null);
      setBranchNew(false);
      setBranchAuto(false);
    }
  }

  // ---- agent options ----
  const agentQuery = agentValue.trim();
  const agentMatches = searchAgencies(agentValue, partnerScope);
  const agentExact = agentMatches.some((a) => a.name.toLowerCase() === agentQuery.toLowerCase());
  // For an admin viewing all partners, the same name can exist under two
  // partners; label each option with its partner so the choice is explicit.
  const partnerName = (slug: string) => getPartners().find((p) => p.id === slug)?.name ?? slug;
  const agentOptions: TypeAheadOption[] = agentMatches.map((a) => ({
    id: `${a.partner}:${a.name}`,
    icon: <Icon name="building" />,
    main: highlightMatch(a.name, agentQuery),
    sub: `${a.branches.length} branch${a.branches.length === 1 ? '' : 'es'}${isAdmin ? ` · ${partnerName(a.partner)}` : ''}`,
    onSelect: () => chooseAgency(a.name, false, a.partner),
  }));
  if (agentQuery && !agentExact) {
    agentOptions.push({
      id: '__create-agent',
      icon: <Icon name="plus" />,
      main: <>Create new agent &quot;{agentQuery}&quot;</>,
      sub: 'Add an agency not in the list',
      isNew: true,
      onSelect: () => { createAgencyOnTheFly(agentQuery, partnerScope); createdAgencies.current.add(agentQuery.toLowerCase()); chooseAgency(agentQuery, true); },
    });
  }

  function commitAgentEnter() {
    const q = agentValue.trim();
    if (!q) return;
    const matches = searchAgencies('', partnerScope).filter((a) => a.name.toLowerCase() === q.toLowerCase());
    // Ambiguous same-named agencies across partners (admin, all-partners): do
    // not tie-break silently on Enter - require an explicit pick from the list.
    if (matches.length > 1) return;
    if (matches.length === 1) chooseAgency(matches[0].name, false, matches[0].partner);
    else { createAgencyOnTheFly(q, partnerScope); createdAgencies.current.add(q.toLowerCase()); chooseAgency(q, true); }
  }

  // ---- branch options ----
  const branchQuery = branchValue.trim();
  const agencyRec = selectedAgency ? findAgency(selectedAgency) : undefined;
  const branchMatches = selectedAgency ? searchBranches(selectedAgency, branchValue) : [];
  const branchExact = branchMatches.some((b) => b.name.toLowerCase() === branchQuery.toLowerCase());
  const branchOptions: TypeAheadOption[] = branchMatches.map((b) => ({
    id: b.name,
    icon: <Icon name="home" />,
    main: highlightMatch(b.name, branchQuery),
    sub: b.area || '',
    onSelect: () => chooseBranch(b.name, false),
  }));
  if (branchQuery && !branchExact && selectedAgency) {
    branchOptions.push({
      id: '__create-branch',
      icon: <Icon name="plus" />,
      main: <>Create new branch &quot;{branchQuery}&quot; in {selectedAgency}</>,
      sub: 'Add a branch to this agent',
      isNew: true,
      onSelect: () => { createBranchOnTheFly(selectedAgency, branchQuery); chooseBranch(branchQuery, true); },
    });
  }

  function commitBranchEnter() {
    if (!selectedAgency) return;
    const q = branchValue.trim();
    if (!q || !agencyRec) return;
    const existing = agencyRec.branches.find((b) => b.name.toLowerCase() === q.toLowerCase());
    if (existing) chooseBranch(existing.name, false);
    else { createBranchOnTheFly(selectedAgency, q); chooseBranch(q, true); }
  }

  const branchEmpty = selectedAgency
    ? (agencyRec && agencyRec.branches.length === 0
        ? 'This agency has no branches yet. Leave "Head office" or type a branch name.'
        : 'No branches found. Type a name to add one.')
    : 'Select an agent first';

  const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };

  return (
    <div className="form-grid">
      <div className="field span-2">
        <label htmlFor="ag-name">Agent</label>
        <TypeAhead
          id="ag-name"
          value={agentValue}
          onChange={resetAgent}
          onEnter={commitAgentEnter}
          options={agentOptions}
          placeholder="Search agencies or add a new one"
          emptyText="No agencies found. Type a name to add one"
        />
      </div>
      {/* #74 New agency: ask explicitly (no default) whether it is single-office. */}
      {agencyNew && (
        <div className="field span-2">
          <label>Is this a single-office agency? <span className="req" aria-hidden="true">*</span></label>
          <div className="radio-row" role="radiogroup" aria-label="Is this a single-office agency?">
            <label className="radio-opt">
              <input type="radio" name="single-office" checked={singleOffice === true} onChange={() => answerSingleOffice(true)} />
              <span>Yes, a single office</span>
            </label>
            <label className="radio-opt">
              <input type="radio" name="single-office" checked={singleOffice === false} onChange={() => answerSingleOffice(false)} />
              <span>No, it has branches</span>
            </label>
          </div>
          <span className="hint">
            {singleOffice === true
              ? <>A branch named <b>{selectedAgency}, Head office</b> will be created automatically, inheriting the agency contact.</>
              : 'A single-office agency gets one Head office branch automatically. Choose No to name a branch.'}
          </span>
        </div>
      )}

      {/* Branch field: existing agencies always; a new agency only once it is
          confirmed to have branches. A new single-office agency uses the auto
          Head office branch (read-only) and skips this field. */}
      {agencyNew && singleOffice === true ? (
        <div className="field span-2">
          <label htmlFor="br-name">Branch</label>
          <input id="br-name" type="text" readOnly value={`${selectedAgency}, Head office`} />
          <span className="hint">Auto-created for this single-office agency. Answer No above to name a branch instead.</span>
        </div>
      ) : (!agencyNew || singleOffice === false) ? (
        <div className="field span-2">
          <label htmlFor="br-name">Branch</label>
          <TypeAhead
            id="br-name"
            value={branchValue}
            onChange={onBranchInput}
            onEnter={commitBranchEnter}
            options={branchOptions}
            placeholder={selectedAgency ? 'Search branches or add a new one' : 'Select an agent first'}
            disabled={!selectedAgency}
            emptyText={branchEmpty}
          />
          {branchAuto ? (
            <span className="hint">Single-office agent. A <b>Head office</b> branch will be used, inheriting the agency contact. Type a branch name to change it.</span>
          ) : (
            <span className="hint">Branches are filtered to the selected agent. Add a new branch on the fly if it is not listed.</span>
          )}
        </div>
      ) : null}

      {agencyNew && (
        <div className="field span-2" style={{ background: 'var(--white-lilac)', border: '1px solid var(--line)', borderRadius: 'var(--r-md, 10px)', padding: 14 }}>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>New agency contact</div>
          <div className="form-grid">
            {isAdmin && (
              <div className="field span-2" style={fieldStyle}>
                <label htmlFor="ag-partner">Partner <span className="req" aria-hidden="true">*</span></label>
                <select id="ag-partner" value={adminPartner} onChange={(e) => setAdminPartner(e.target.value)}>
                  <option value="">Select the partner this agent belongs to</option>
                  {getPartners().map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <span className="hint">The referral and its commission land under this partner.</span>
              </div>
            )}
            <div className="field span-2" style={fieldStyle}>
              <label htmlFor="ag-email">Contact email <span className="req" aria-hidden="true">*</span></label>
              <input id="ag-email" type="email" placeholder="agent@agency.co.uk" value={agEmail} onChange={(e) => setAgEmail(e.target.value)} />
            </div>
            <div className="field" style={fieldStyle}>
              <label htmlFor="ag-cname">Contact name <span className="hint">(optional)</span></label>
              <input id="ag-cname" type="text" placeholder="e.g. Jordan Blake" value={agName} onChange={(e) => setAgName(e.target.value)} />
            </div>
            <div className="field" style={fieldStyle}>
              <label htmlFor="ag-phone">Contact phone <span className="hint">(optional)</span></label>
              <input id="ag-phone" type="tel" placeholder="020 7946 0000" value={agPhone} onChange={(e) => setAgPhone(e.target.value)} />
            </div>
          </div>
          <span className="hint">Required for a new agency. Becomes its default contact for deed delivery and the bordereau.</span>
        </div>
      )}

      {branchNew && !branchAuto && (
        <div className="field span-2" style={{ background: 'var(--white-lilac)', border: '1px solid var(--line)', borderRadius: 'var(--r-md, 10px)', padding: 14 }}>
          <label htmlFor="br-email">New branch contact email <span className="hint">(optional)</span></label>
          <input id="br-email" type="email" placeholder="branch@agency.co.uk" value={brEmail} onChange={(e) => setBrEmail(e.target.value)} />
          <span className="hint">Optional. If left blank, this branch inherits the agency's default contact.</span>
        </div>
      )}
    </div>
  );
}
