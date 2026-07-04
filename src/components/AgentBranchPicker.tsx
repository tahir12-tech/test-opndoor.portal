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

   Entities created here write to the client org store for the picker UI; they
   are persisted (as pending_review) and the contact captured server-side when
   the referral is submitted (create-referral -> create_referral_target).
   ===================================================================== */
import { useEffect, useRef, useState } from 'react';
import { createAgencyOnTheFly, createBranchOnTheFly, findAgency, searchAgencies, searchBranches } from '@/data';
import { useSession } from '@/session/SessionContext';
import { Icon } from '@/components/ui/Icon';
import { TypeAhead, highlightMatch, type TypeAheadOption } from '@/components/ui/TypeAhead';

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
}

export function AgentBranchPicker({ onChange }: { onChange?: (value: AgentBranchValue) => void }) {
  const { partnerScope } = useSession();
  const [agentValue, setAgentValue] = useState('');
  const [selectedAgency, setSelectedAgency] = useState<string | null>(null);
  const [agencyNew, setAgencyNew] = useState(false);
  const [branchValue, setBranchValue] = useState('');
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [branchNew, setBranchNew] = useState(false);
  const [agEmail, setAgEmail] = useState('');
  const [agName, setAgName] = useState('');
  const [agPhone, setAgPhone] = useState('');
  const [brEmail, setBrEmail] = useState('');
  // Names created on the fly in this picker. An on-the-fly agency also lands in
  // the client org store, so it shows up as an "existing" search hit; this set
  // keeps it flagged as new (so re-selecting it still requires a contact and
  // creates a contact-bearing record on submit).
  const createdAgencies = useRef<Set<string>>(new Set());

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
      branchContactEmail: brEmail.trim(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgency, selectedBranch, agencyNew, branchNew, agEmail, agName, agPhone, brEmail]);

  function chooseAgency(name: string, isNewArg: boolean) {
    // A picker-created agency stays "new" even when re-selected from the list.
    const isNew = isNewArg || createdAgencies.current.has(name.toLowerCase());
    setSelectedAgency(name);
    setAgentValue(name);
    setAgencyNew(isNew);
    setBranchValue('');
    setSelectedBranch(null);
    setBranchNew(false);
    setBrEmail('');
    if (!isNew) { setAgEmail(''); setAgName(''); setAgPhone(''); }
  }

  function resetAgent(v: string) {
    setAgentValue(v);
    setSelectedAgency(null);
    setAgencyNew(false);
    setBranchValue('');
    setSelectedBranch(null);
    setBranchNew(false);
    setAgEmail(''); setAgName(''); setAgPhone(''); setBrEmail('');
  }

  function chooseBranch(name: string, isNew: boolean) {
    setBranchValue(name);
    setSelectedBranch(name);
    setBranchNew(isNew);
    if (!isNew) setBrEmail('');
  }

  function onBranchInput(v: string) {
    setBranchValue(v);
    // Editing away from the committed branch de-selects it.
    if (v.trim().toLowerCase() !== (selectedBranch ?? '').toLowerCase()) {
      setSelectedBranch(null);
      setBranchNew(false);
    }
  }

  // ---- agent options ----
  const agentQuery = agentValue.trim();
  const agentMatches = searchAgencies(agentValue, partnerScope);
  const agentExact = agentMatches.some((a) => a.name.toLowerCase() === agentQuery.toLowerCase());
  const agentOptions: TypeAheadOption[] = agentMatches.map((a) => ({
    id: a.name,
    icon: <Icon name="building" />,
    main: highlightMatch(a.name, agentQuery),
    sub: `${a.branches.length} branch${a.branches.length === 1 ? '' : 'es'}`,
    onSelect: () => chooseAgency(a.name, false),
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
    const existing = searchAgencies('', partnerScope).find((a) => a.name.toLowerCase() === q.toLowerCase());
    if (existing) chooseAgency(existing.name, false);
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

  // A just-created agency has no branches yet: guide the user to add the first one.
  const branchEmpty = selectedAgency
    ? (agencyRec && agencyRec.branches.length === 0
        ? 'This agency has no branches yet. Type a branch name to add its first branch.'
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
        <span className="hint">Branches are filtered to the selected agent. Add a new branch on the fly if it is not listed.</span>
      </div>

      {agencyNew && (
        <div className="field span-2" style={{ background: 'var(--white-lilac)', border: '1px solid var(--line)', borderRadius: 'var(--r-md, 10px)', padding: 14 }}>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>New agency contact</div>
          <div className="form-grid">
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

      {branchNew && (
        <div className="field span-2" style={{ background: 'var(--white-lilac)', border: '1px solid var(--line)', borderRadius: 'var(--r-md, 10px)', padding: 14 }}>
          <label htmlFor="br-email">New branch contact email <span className="hint">(optional)</span></label>
          <input id="br-email" type="email" placeholder="branch@agency.co.uk" value={brEmail} onChange={(e) => setBrEmail(e.target.value)} />
          <span className="hint">Optional. If left blank, this branch inherits the agency's default contact.</span>
        </div>
      )}
    </div>
  );
}
