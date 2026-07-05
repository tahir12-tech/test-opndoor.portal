/* =====================================================================
   #1 Tenant payment confirmation page (/pay?token=...). Public, read-only,
   tokenised, mobile-first. Sits between the payment email and Stripe. The Pay
   button mints a fresh Stripe Checkout session server-side and redirects.
   #13 Expired applications get a fresh payment link (never a dead end).
   #14 Carries a quiet, two-step tenant self-decline.
   No login, no navigation, no data entry (beyond the decline confirm).
   ===================================================================== */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PayFrame } from './PayFrame';
import { getPayPage, startCheckout, declineApplication, type PayPageData } from './paymentPageApi';
import { Icon } from '@/components/ui/Icon';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

type Phase = 'loading' | 'ready' | 'paid' | 'closed' | 'invalid' | 'declined';

const DECLINE_REASONS = [
  { value: 'another_guarantor', label: 'I found another guarantor' },
  { value: 'tenancy_fell_through', label: 'The tenancy fell through' },
  { value: 'other', label: 'Other' },
];

function Row({ k, v }: { k: string; v: string }) {
  return <div className="pay__rrow"><span className="pay__rk">{k}</span><span className="pay__rv">{v}</span></div>;
}

function Faq({ q, a }: { q: string; a: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`pay__faq${open ? ' is-open' : ''}`}>
      <button type="button" className="pay__faq-q" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{q}</span><Icon name="chevronDown" />
      </button>
      {open && <div className="pay__faq-a">{a}</div>}
    </div>
  );
}

export function PayLanding() {
  useDocumentTitle('Your guarantor fee');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const utm = params.get('utm_source') || 'confirmation_page';

  const [phase, setPhase] = useState<Phase>('loading');
  const [data, setData] = useState<PayPageData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // #14 decline sub-flow: null (not started) -> confirm form -> submitting
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('another_guarantor');

  const load = useCallback(async () => {
    if (!token) { setPhase('invalid'); return; }
    const d = await getPayPage(token);
    if (!d.ok) {
      // A transient blip keeps the page trying; a definitive failure shows invalid.
      if (d.transient) { setTimeout(() => void load(), 2500); return; }
      setPhase('invalid'); return;
    }
    setData(d);
    setPhase(d.isPaid ? 'paid' : d.isClosed ? 'closed' : 'ready');
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const pay = async () => {
    setBusy(true); setErr('');
    const r = await startCheckout(token, utm);
    if (r.ok && r.url) { window.location.href = r.url; return; }
    setErr(r.error || 'We could not start the payment. Please try again.');
    setBusy(false);
  };

  const confirmDecline = async () => {
    setBusy(true); setErr('');
    const r = await declineApplication(token, declineReason);
    setBusy(false);
    if (!r.ok) { setErr(r.error || 'Could not record that. Please contact hello@opndoor.co.'); return; }
    // Idempotent: if it was already paid meanwhile, reflect that instead.
    if (r.status === 'paid' || r.status === 'deed') { setPhase('paid'); return; }
    setPhase('declined');
  };

  if (phase === 'loading') {
    return <PayFrame><div className="pay__spinner" /><p className="pay__lead" style={{ textAlign: 'center' }}>Loading your details…</p></PayFrame>;
  }

  if (phase === 'invalid') {
    return (
      <PayFrame>
        <div className="pay__icon pay__icon--warn"><Icon name="alert" /></div>
        <h1 className="pay__title">This link is not valid</h1>
        <p className="pay__lead">This payment link may have expired or been mistyped. Please use the most recent email we sent you, or contact us at <a href="mailto:hello@opndoor.co">hello@opndoor.co</a>.</p>
      </PayFrame>
    );
  }

  if (phase === 'paid') {
    return (
      <PayFrame>
        <div className="pay__icon pay__icon--ok"><Icon name="check" /></div>
        <h1 className="pay__title">This fee has been paid</h1>
        <p className="pay__lead">Thank you, your guarantor fee has been paid and nothing more is needed. Your Deed of Guarantee will be sent to you to sign electronically{data?.ref ? <> (reference <b>{data.ref}</b>)</> : null}.</p>
      </PayFrame>
    );
  }

  if (phase === 'declined') {
    return (
      <PayFrame>
        <div className="pay__icon pay__icon--ok"><Icon name="check" /></div>
        <h1 className="pay__title">Thanks for letting us know</h1>
        <p className="pay__lead">No payment is needed. If this changes, contact us at <a href="mailto:hello@opndoor.co">hello@opndoor.co</a>{data?.ref ? <> quoting <b>{data.ref}</b></> : null} and we'll help.</p>
      </PayFrame>
    );
  }

  if (phase === 'closed') {
    // Staff-closed / withdrawn: not payable, not a tenant decline flow.
    return (
      <PayFrame>
        <div className="pay__icon pay__icon--warn"><Icon name="info" /></div>
        <h1 className="pay__title">This referral is closed</h1>
        <p className="pay__lead">No payment is needed for this referral. If you think this is a mistake, contact us at <a href="mailto:hello@opndoor.co">hello@opndoor.co</a>{data?.ref ? <> quoting <b>{data.ref}</b></> : null}.</p>
      </PayFrame>
    );
  }

  // phase === 'ready' (Sent, or #13 Expired — both payable; expired gets a fresh link)
  const d = data!;
  const expiredNote = d.isExpired;

  if (declineOpen) {
    return (
      <PayFrame>
        <h1 className="pay__title">No longer need a guarantor?</h1>
        <p className="pay__lead">To close this off, please confirm below. A single click won't withdraw anything, we just want to be sure.</p>
        <div className="pay__field">
          <label htmlFor="decline-reason">Reason (optional)</label>
          <select id="decline-reason" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)}>
            {DECLINE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        {err && <p className="pay__err">{err}</p>}
        <button type="button" className="pay__btn pay__btn--primary" disabled={busy} onClick={() => void confirmDecline()}>
          {busy ? 'Saving…' : 'I no longer need a guarantor for this tenancy'}
        </button>
        <button type="button" className="pay__btn pay__btn--dark" disabled={busy} onClick={() => { setDeclineOpen(false); setErr(''); }} style={{ marginTop: 10 }}>
          Go back
        </button>
      </PayFrame>
    );
  }

  return (
    <PayFrame>
      <h1 className="pay__title">Your guarantor fee, {d.addr1}</h1>
      <p className="pay__lead">You've been referred via {d.partnerName} for opndoor's professional guarantor service, for your tenancy at {d.propFull}.</p>
      <p className="pay__lead">opndoor stands as your professional guarantor: we provide a Deed of Guarantee in favour of the property, covering 12 months from your tenancy start, so your tenancy can proceed.</p>

      {expiredNote && (
        <p className="pay__note">This link had lapsed, so we've refreshed it for you. You can still pay below, your referral will pick up right where it left off.</p>
      )}

      <div className="pay__receipt">
        <Row k="Tenant" v={d.tenantName || '—'} />
        <Row k="Property" v={d.propFull || '—'} />
        <Row k="Tenancy start" v={d.tenancyStart || '—'} />
        <Row k="Monthly rent" v={`£${(d.monthlyRent ?? 0).toLocaleString('en-GB')}`} />
      </div>

      <div className="pay__fee">
        <div className="pay__fee-k">Guarantor fee</div>
        <div className="pay__fee-v">{d.feeGBP}</div>
        <div className="pay__fee-s">One month's rent. One-off payment. Reference {d.ref}.</div>
      </div>

      <div className="pay__after">
        <div className="pay__after-h">What happens after you pay</div>
        <p>You'll be sent your Deed of Guarantee to sign electronically (it takes two minutes), your letting agent receives the executed deed, and your tenancy proceeds. Nothing else is needed from you.</p>
      </div>

      {err && <p className="pay__err">{err}</p>}
      <button type="button" className="pay__btn pay__btn--primary" disabled={busy} onClick={() => void pay()}>
        {busy ? 'Starting secure payment…' : 'Pay the guarantor fee'}
      </button>
      <p className="pay__secure"><Icon name="lock" /> Payment is secure and handled by Stripe.</p>

      <p className="pay__fine">Spot something wrong in your details? Contact us at <a href="mailto:hello@opndoor.co">hello@opndoor.co</a> quoting {d.ref} before paying, and we'll put it right.</p>

      <div className="pay__faqs">
        <Faq q="What is a Deed of Guarantee?" a={<>It's a legal deed in which opndoor acts as your professional guarantor, in favour of the property. It lets your tenancy proceed when you can't provide your own guarantor. It's a professional guarantor service, not insurance.</>} />
        <Faq q="What does it cover?" a={<>It supports your obligations under the tenancy, such as rent, for 12 months from your tenancy start. If there's ever a claim, your letting agent is the point of contact with opndoor.</>} />
        <Faq q="When does the guarantee take effect?" a={<>Your Deed of Guarantee is in force from your tenancy start date, {d.tenancyStart}, and covers 12 months from then. The guarantor fee is non-refundable from your tenancy start date. If your circumstances change before then, contact us at <a href="mailto:hello@opndoor.co">hello@opndoor.co</a> quoting {d.ref}.</>} />
      </div>

      <button type="button" className="pay__decline" onClick={() => { setDeclineOpen(true); setErr(''); }}>
        No longer need this? Let us know.
      </button>
    </PayFrame>
  );
}
