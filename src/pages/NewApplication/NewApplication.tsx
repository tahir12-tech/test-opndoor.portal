/* =====================================================================
   New application — create a referral.

   Enforces the required-field spec on the client (required markers, inline
   errors, submit disabled until valid) to match the database constraints and
   the create_referral RPC. Submitting posts through the service layer; RPC
   errors (which name the offending fields) are surfaced readably.

   Property entry is postcode-first when an address-lookup provider is
   configured (see addressService), and falls back to manual entry otherwise.
   Manual entry is always available via a toggle.
   ===================================================================== */
import { useState, type ClipboardEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { addressLookupAvailable, ALL_PARTNERS, createReferral, findActiveReferralByTenantProperty, lookupAddresses, type AddressOption, type DuplicateMatch } from '@/data';
import { Modal } from '@/components/ui/Modal';
import { TITLE_OPTIONS, validateReferral, parseFlexibleDate, toISODate, type ReferralValues } from '@/lib/validation';
import { useSession } from '@/session/SessionContext';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Field } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { AgentBranchPicker } from '@/components/AgentBranchPicker';
import './NewApplication.css';

const Req = () => <span className="req" aria-hidden="true">*</span>;

const EMPTY: ReferralValues = {
  title: '', first: '', last: '', dob: '', email: '', phone: '',
  addr1: '', addr2: '', city: '', county: '', postcode: '',
  rent: '', tenancyStart: '', agency: '', branch: '',
};

export function NewApplication() {
  usePageMeta('new', 'New application', ['Home', 'Applications', 'New']);
  const navigate = useNavigate();
  const { refresh, role, partnerScope } = useSession();
  const toast = useToast();

  const [values, setValues] = useState<ReferralValues>(EMPTY);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dupWarn, setDupWarn] = useState<DuplicateMatch | null>(null); // #5 duplicate soft warning
  // On-the-fly org creation extras from the AgentBranchPicker (contact capture
  // and, for an admin, the target partner the referral lands under).
  const [org, setOrg] = useState({
    agencyNew: false, branchNew: false,
    agencyContactEmail: '', agencyContactName: '', agencyContactPhone: '', branchContactEmail: '',
    partner: '', singleOffice: null as boolean | null,
  });

  // address lookup
  const lookupAvailable = addressLookupAvailable();
  const [addrMode, setAddrMode] = useState<'lookup' | 'manual'>(lookupAvailable ? 'lookup' : 'manual');
  const [lookupPostcode, setLookupPostcode] = useState('');
  const [lookupResults, setLookupResults] = useState<AddressOption[]>([]);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupMsg, setLookupMsg] = useState('');

  const errors = validateReferral(values);
  // A newly-created agency must capture a contact email (its default contact).
  const agencyEmailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(org.agencyContactEmail);
  const orgContactError = org.agencyNew && !agencyEmailOk;
  // An admin fly-creating an agency must choose the partner it lands under (#66).
  const orgPartnerError = org.agencyNew && role === 'superadmin' && !org.partner;
  // A new agency must answer the single-office question before submit (#74).
  const orgOfficeError = org.agencyNew && org.singleOffice === null;
  const isValid = Object.keys(errors).length === 0 && !orgContactError && !orgPartnerError && !orgOfficeError;
  const set = (k: keyof ReferralValues, v: string) => setValues((prev) => ({ ...prev, [k]: v }));
  // #103 Native date inputs reject pasted text in common formats; parse it and
  // normalise to yyyy-mm-dd so Rightmove's copy-paste workflow just works.
  const onPasteDate = (field: 'dob' | 'tenancyStart') => (e: ClipboardEvent<HTMLInputElement>) => {
    const parsed = parseFlexibleDate(e.clipboardData.getData('text'));
    if (parsed) { e.preventDefault(); set(field, toISODate(parsed)); }
  };
  const markTouched = (k: string) => setTouched((t) => new Set(t).add(k));
  const err = (k: keyof ReferralValues) => ((submitted || touched.has(k)) ? errors[k] : undefined);

  // Native date-input bounds (dd/mm/yyyy display in en-GB; value is yyyy-mm-dd).
  const isoOf = (dd: Date) => `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
  const nowD = new Date();
  const dobMax = isoOf(nowD);
  const dobMin = isoOf(new Date(nowD.getFullYear() - 100, nowD.getMonth(), nowD.getDate()));
  const startMin = isoOf(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() - 7));
  const startMax = isoOf(new Date(nowD.getFullYear() + 2, nowD.getMonth(), nowD.getDate()));

  async function runLookup() {
    setLookupBusy(true);
    setLookupMsg('');
    setLookupResults([]);
    const r = await lookupAddresses(lookupPostcode);
    setLookupBusy(false);
    if (!r.available) { setAddrMode('manual'); return; }
    if (r.error) { setLookupMsg(r.error); return; }
    if (!r.addresses.length) { setLookupMsg('No addresses found for that postcode.'); return; }
    setLookupResults(r.addresses);
  }

  function pickAddress(a: AddressOption) {
    setValues((prev) => ({ ...prev, addr1: a.line1, addr2: a.line2, city: a.city, county: a.county, postcode: a.postcode }));
    setTouched((t) => new Set([...t, 'addr1', 'city', 'postcode']));
    setLookupResults([]);
    setAddrMode('manual');
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitted(true);
    setFormError('');
    if (!isValid || busy) return;
    // #5 Soft duplicate guard: warn (never block) if an active referral already
    // exists for this tenant + property. Continue anyway proceeds unconditionally.
    const dup = findActiveReferralByTenantProperty({ role, scope: partnerScope }, values.email.trim(), values.postcode.trim());
    if (dup) { setDupWarn(dup); return; }
    void doCreate();
  }

  async function doCreate() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await createReferral({
        title: values.title, firstName: values.first.trim(), lastName: values.last.trim(),
        dob: values.dob.trim(), email: values.email.trim(), phone: values.phone.trim(),
        addr1: values.addr1.trim(), addr2: values.addr2.trim(), city: values.city.trim(),
        county: values.county.trim(), postcode: values.postcode.trim(),
        rent: Number(values.rent), tenancyStart: values.tenancyStart.trim(),
        agency: values.agency, branch: values.branch,
        agencyNew: org.agencyNew, branchNew: org.branchNew,
        agencyContactEmail: org.agencyContactEmail, agencyContactName: org.agencyContactName,
        agencyContactPhone: org.agencyContactPhone, branchContactEmail: org.branchContactEmail,
        // The partner the referral belongs to, resolved by the picker (the
        // chosen agency's own partner, or the admin's selected partner for a
        // fly-created agency). Server ignores it for partner users, whose own
        // partner is authoritative. Fall back to a specific ambient scope.
        partner: org.partner || (partnerScope === ALL_PARTNERS ? undefined : partnerScope),
      });
      await refresh();
      toast(res.emailSent
        ? 'Application sent. The tenant payment email was delivered to the review address.'
        : `Application created. Tenant email not sent${res.emailError ? ': ' + res.emailError : '.'}`);
      navigate(`/applications/${res.ref}`);
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : 'Could not send the application.';
      setFormError(msg);
      toast(msg);
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || (submitted && !isValid);

  return (
    <>
      <div className="page-head">
        <div>
          <Eyebrow>New referral</Eyebrow>
          <h1 className="page-head__title" style={{ marginTop: 10 }}>New application</h1>
          <p className="page-head__sub">Refer a failed-referencing tenant to opndoor's professional guarantor service, where opndoor provides a Deed of Guarantee in favour of the property. Complete each section, then send the application. Fields marked <span className="req">*</span> are required.</p>
        </div>
        <div className="page-head__actions">
          <Button variant="ghost" size="sm" to="/applications">Cancel</Button>
          <Button variant="primary" size="sm" type="submit" form="na-form" arrow disabled={disabled}>{busy ? 'Sending…' : 'Send application'}</Button>
        </div>
      </div>

      <div className="na-grid">
        <form className="na-form" id="na-form" onSubmit={submit} noValidate>
          {/* 1. TENANT */}
          <section className="card sec" id="sec-tenant">
            <div className="sec__head"><span className="sec__num">1</span><div><div className="sec__title">Tenant</div><div className="sec__sub">The tenant being referred</div></div></div>
            <CardBody>
              <div className="form-grid">
                <Field label={<>Title <Req /></>} htmlFor="t-title" style={{ maxWidth: 140 }} error={err('title')}>
                  <select id="t-title" name="title" value={values.title} onChange={(e) => set('title', e.target.value)} onBlur={() => markTouched('title')}>
                    <option value="" disabled>Select…</option>
                    {TITLE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                <div className="field span-2" style={{ gridColumn: '2 / 3' }} />
                <Field label={<>First name <Req /></>} htmlFor="t-first" error={err('first')}>
                  <input id="t-first" type="text" placeholder="Amelia" value={values.first} onChange={(e) => set('first', e.target.value)} onBlur={() => markTouched('first')} />
                </Field>
                <Field label={<>Last name <Req /></>} htmlFor="t-last" error={err('last')}>
                  <input id="t-last" type="text" placeholder="Hartley" value={values.last} onChange={(e) => set('last', e.target.value)} onBlur={() => markTouched('last')} />
                </Field>
                <Field label={<>Date of birth <Req /></>} htmlFor="t-dob" error={err('dob')}>
                  <input id="t-dob" type="date" min={dobMin} max={dobMax} value={values.dob} onChange={(e) => set('dob', e.target.value)} onPaste={onPasteDate('dob')} onBlur={() => markTouched('dob')} />
                </Field>
                <Field label={<>Email <Req /></>} htmlFor="t-email" error={err('email')}>
                  <input id="t-email" type="email" placeholder="amelia@example.com" value={values.email} onChange={(e) => set('email', e.target.value)} onBlur={() => markTouched('email')} />
                </Field>
                <Field label={<>Phone <Req /></>} htmlFor="t-phone" error={err('phone')}>
                  <input id="t-phone" type="tel" placeholder="07700 900000" value={values.phone} onChange={(e) => set('phone', e.target.value)} onBlur={() => markTouched('phone')} />
                </Field>
              </div>
            </CardBody>
          </section>

          {/* 2. PROPERTY */}
          <section className="card sec" id="sec-property">
            <div className="sec__head"><span className="sec__num">2</span><div><div className="sec__title">Property</div><div className="sec__sub">The address being let</div></div></div>
            <CardBody>
              {addrMode === 'lookup' ? (
                <div className="addr-lookup">
                  <div className="addr-lookup__row">
                    <Field label="Find address by postcode" htmlFor="addr-pc" style={{ flex: 1 }}>
                      <input id="addr-pc" type="text" placeholder="e.g. SW7 3LA" value={lookupPostcode}
                        onChange={(e) => setLookupPostcode(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runLookup(); } }} />
                    </Field>
                    <Button type="button" variant="dark" onClick={() => void runLookup()} disabled={lookupBusy || !lookupPostcode.trim()}>
                      {lookupBusy ? 'Searching…' : 'Find address'}
                    </Button>
                  </div>
                  {lookupMsg && <p className="addr-lookup__msg">{lookupMsg}</p>}
                  {lookupResults.length > 0 && (
                    <div className="addr-results" role="listbox" aria-label="Addresses">
                      {lookupResults.map((a, i) => (
                        <button type="button" className="addr-result" key={i} onClick={() => pickAddress(a)}>
                          <Icon name="home" /> <span>{a.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <button type="button" className="addr-toggle" onClick={() => setAddrMode('manual')}>Enter address manually</button>
                </div>
              ) : (
                <>
                  <div className="form-grid">
                    <Field label={<>Address line 1 <Req /></>} htmlFor="p-l1" span2 error={err('addr1')}>
                      <input id="p-l1" type="text" placeholder="Flat 4, 18 Onslow Gardens" value={values.addr1} onChange={(e) => set('addr1', e.target.value)} onBlur={() => markTouched('addr1')} />
                    </Field>
                    <Field label="Address line 2" htmlFor="p-l2" hint="Optional" span2>
                      <input id="p-l2" type="text" value={values.addr2} onChange={(e) => set('addr2', e.target.value)} />
                    </Field>
                    <Field label={<>City / town <Req /></>} htmlFor="p-city" error={err('city')}>
                      <input id="p-city" type="text" placeholder="London" value={values.city} onChange={(e) => set('city', e.target.value)} onBlur={() => markTouched('city')} />
                    </Field>
                    <Field label="County" htmlFor="p-county" hint="Optional">
                      <input id="p-county" type="text" placeholder="Greater London" value={values.county} onChange={(e) => set('county', e.target.value)} />
                    </Field>
                    <Field label={<>Postcode <Req /></>} htmlFor="p-post" style={{ maxWidth: 220 }} error={err('postcode')}>
                      <input id="p-post" type="text" placeholder="SW7 3LA" value={values.postcode} onChange={(e) => set('postcode', e.target.value)} onBlur={() => markTouched('postcode')} />
                    </Field>
                  </div>
                  {lookupAvailable && (
                    <button type="button" className="addr-toggle" onClick={() => { setAddrMode('lookup'); setLookupResults([]); setLookupMsg(''); }}>Find address by postcode instead</button>
                  )}
                </>
              )}
            </CardBody>
          </section>

          {/* 3. TENANCY */}
          <section className="card sec" id="sec-tenancy">
            <div className="sec__head"><span className="sec__num">3</span><div><div className="sec__title">Tenancy</div><div className="sec__sub">Rent and start date</div></div></div>
            <CardBody>
              <div className="form-grid">
                <Field label={<>Monthly rent (£) <Req /></>} htmlFor="ty-rent" error={err('rent')}>
                  <input id="ty-rent" type="number" min="1" step="1" placeholder="2450" value={values.rent} onChange={(e) => set('rent', e.target.value)} onBlur={() => markTouched('rent')} />
                </Field>
                <Field label={<>Tenancy start date <Req /></>} htmlFor="ty-start" error={err('tenancyStart')}>
                  <input id="ty-start" type="date" min={startMin} max={startMax} value={values.tenancyStart} onChange={(e) => set('tenancyStart', e.target.value)} onPaste={onPasteDate('tenancyStart')} onBlur={() => markTouched('tenancyStart')} />
                </Field>
              </div>
            </CardBody>
          </section>

          {/* 4. AGENT & BRANCH */}
          <section className="card sec" id="sec-branch">
            <div className="sec__head"><span className="sec__num">4</span><div><div className="sec__title">Agent &amp; branch <Req /></div><div className="sec__sub">Select the agent this referral belongs to, then the branch. You can add a new agent or branch on the fly.</div></div></div>
            <CardBody>
              <AgentBranchPicker onChange={(v) => {
                setValues((prev) => ({ ...prev, agency: v.agency, branch: v.branch }));
                setOrg({ agencyNew: v.agencyNew, branchNew: v.branchNew, agencyContactEmail: v.agencyContactEmail, agencyContactName: v.agencyContactName, agencyContactPhone: v.agencyContactPhone, branchContactEmail: v.branchContactEmail, partner: v.partner, singleOffice: v.singleOffice });
              }} />
              {submitted && orgPartnerError && <p className="na-form-error" style={{ marginTop: 8 }}>Select the partner this new agency belongs to.</p>}
              {submitted && orgOfficeError && <p className="na-form-error" style={{ marginTop: 8 }}>Tell us whether this is a single-office agency.</p>}
              {submitted && orgContactError && <p className="na-form-error" style={{ marginTop: 8 }}>Enter a contact email for the new agency.</p>}
              {submitted && !orgOfficeError && (errors.agency || errors.branch) && (
                <span className="field-error" style={{ marginTop: 10 }}>Select an agent and a branch.</span>
              )}
            </CardBody>
          </section>

          <div style={{ marginTop: 6 }}>
            <p style={{ fontSize: 12.5, color: 'var(--ink-mute)', margin: '0 0 12px' }}>Guarantee reference, issue date and expiry are assigned automatically.</p>
            {formError && <p className="na-form-error">{formError}</p>}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <Button variant="ghost" to="/applications">Cancel</Button>
              <Button variant="primary" type="submit" arrow disabled={disabled}>{busy ? 'Sending…' : 'Send application'}</Button>
            </div>
          </div>
        </form>

        {/* RAIL */}
        <aside className="na-rail">
          <Card>
            <CardBody style={{ padding: 16 }}>
              <div className="navrail">
                <a href="#sec-tenant" className="is-active"><span className="dot" />Tenant</a>
                <a href="#sec-property"><span className="dot" />Property</a>
                <a href="#sec-tenancy"><span className="dot" />Tenancy</a>
                <a href="#sec-branch"><span className="dot" />Agent &amp; branch</a>
              </div>
            </CardBody>
          </Card>
        </aside>
      </div>

      {/* #5 Duplicate-referral soft warning (never blocks). */}
      <Modal
        open={!!dupWarn}
        onClose={() => setDupWarn(null)}
        width={460}
        title="Possible duplicate referral"
        footer={<>
          <Button variant="ghost" onClick={() => setDupWarn(null)}>Go back</Button>
          <Button variant="primary" onClick={() => { setDupWarn(null); void doCreate(); }}>Continue anyway</Button>
        </>}
      >
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.6, margin: 0 }}>
          A referral for this tenant at this property already exists ({dupWarn?.ref}, {dupWarn?.statusLabel}). Continue anyway?
        </p>
      </Modal>
    </>
  );
}
