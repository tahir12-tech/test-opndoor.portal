/* =====================================================================
   /pay/confirmed — the tenant lands here from Stripe on a completed payment
   (success_url). Public, unauthenticated, opndoor-branded, mobile-first.
   Confirms the payment, then polls briefly for the Deed of Guarantee and
   surfaces "Sign your deed now" once it is ready; degrades honestly otherwise.
   ===================================================================== */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '@/components/ui/Icon';
import { PayFrame as Frame } from './PayFrame';
import { getPaymentConfirmation, requestSigningLink, fmtAmount, type PaymentConfirmation } from './paymentApi';

const POLL_MS = 3000;
const MAX_TRIES = 30; // ~90s before we fall back to "we'll email you"

export function PaymentConfirmed() {
  const [params] = useSearchParams();
  const sessionId = params.get('session_id') ?? '';
  const [conf, setConf] = useState<PaymentConfirmation | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signErr, setSignErr] = useState(false);
  const triesRef = useRef(0);

  useEffect(() => {
    if (!sessionId) { setConf({ found: false }); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const c = await getPaymentConfirmation(sessionId);
      if (cancelled) return;
      triesRef.current += 1;
      // A transient failure (network / 5xx / 429) is ignored: keep the prior
      // state and retry. A definitive answer updates state, but never downgrades
      // a payment we have already confirmed back to "not found".
      if (!c.transient) setConf((prev) => (prev?.found && !c.found ? prev : c));
      const definitiveNotFound = !c.transient && !c.found;
      // Settled = payment confirmed AND the deed reached a terminal state. While
      // unpaid (webhook race) we keep polling rather than assert anything.
      const settled = !c.transient && c.found === true && c.paid === true && (c.deedReady || c.deedSigned || c.deedError);
      if (definitiveNotFound || settled) return;
      if (triesRef.current >= MAX_TRIES) { setGaveUp(true); return; }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId]);

  async function onSign() {
    setSigning(true);
    setSignErr(false);
    const url = await requestSigningLink(sessionId);
    if (url) { window.location.href = url; return; }
    setSigning(false);
    setSignErr(true);
  }

  // No data yet. Still polling -> loading; gave up (persistent network trouble)
  // -> honest soft message rather than a false "not found".
  if (conf === null) {
    if (gaveUp) {
      return (
        <Frame>
          <div className="pay__icon pay__icon--wait"><Icon name="mail" strokeWidth={2} /></div>
          <h1 className="pay__title">We&rsquo;re confirming your payment</h1>
          <p className="pay__lead">We&rsquo;re having trouble reaching our servers. If your payment went through, you&rsquo;ll receive an email confirmation and your signing link shortly.</p>
        </Frame>
      );
    }
    return <Frame><div className="pay__spinner" /><p className="pay__lead">Confirming your payment&hellip;</p></Frame>;
  }

  // Definitively couldn't match the session (bad/expired link). Honest, no data.
  if (!conf.found) {
    return (
      <Frame>
        <div className="pay__icon pay__icon--warn"><Icon name="alert" strokeWidth={2} /></div>
        <h1 className="pay__title">We couldn&rsquo;t find your payment</h1>
        <p className="pay__lead">If your payment went through, you&rsquo;ll receive an email confirmation and your signing link shortly.</p>
      </Frame>
    );
  }

  // Found, but the payment is not yet confirmed (webhook race, or a stale/async
  // link). Never assert "paid" until the back end says so.
  if (!conf.paid) {
    return (
      <Frame>
        <div className="pay__spinner" />
        <h1 className="pay__title">Confirming your payment</h1>
        <p className="pay__lead">
          {gaveUp
            ? <>This is taking longer than usual. If your payment went through, you&rsquo;ll receive an email confirmation shortly.</>
            : <>Just a moment while we confirm your guarantor fee{conf.firstName ? `, ${conf.firstName}` : ''}&hellip;</>}
        </p>
      </Frame>
    );
  }

  const deedSettled = conf.deedReady || conf.deedSigned || conf.deedError || gaveUp;

  return (
    <Frame>
      <div className="pay__icon pay__icon--ok"><Icon name="check" strokeWidth={2.4} /></div>
      <h1 className="pay__title">Payment received</h1>
      <p className="pay__lead">
        Thank you{conf.firstName ? `, ${conf.firstName}` : ''}. Your guarantor fee has been paid.
      </p>

      <div className="pay__receipt">
        <div className="pay__rrow"><span className="pay__rk">Amount paid</span><span className="pay__rv pay__rv--amt">{fmtAmount(conf.amount)}</span></div>
        <div className="pay__rrow"><span className="pay__rk">Reference</span><span className="pay__rv">{conf.reference}</span></div>
      </div>

      <div className="pay__deed">
        {conf.deedSigned ? (
          <>
            <div className="pay__icon pay__icon--ok"><Icon name="check" strokeWidth={2.4} /></div>
            <p className="pay__deed-note">Your Deed of Guarantee is signed and in place. You&rsquo;re all set &mdash; nothing more to do.</p>
          </>
        ) : conf.deedReady ? (
          <>
            <p className="pay__deed-note">Your Deed of Guarantee is ready to sign.</p>
            <button className="pay__btn pay__btn--primary" onClick={onSign} disabled={signing}>
              <Icon name="edit" strokeWidth={2} /> {signing ? 'Opening…' : 'Sign your deed now'}
            </button>
            {signErr && <p className="pay__muted">We couldn&rsquo;t open the signing session just now &mdash; we&rsquo;ll email your signing link shortly.</p>}
          </>
        ) : conf.deedError || gaveUp ? (
          <>
            <div className="pay__icon pay__icon--wait"><Icon name="mail" strokeWidth={2} /></div>
            <p className="pay__deed-note">Your Deed of Guarantee is being prepared. We&rsquo;ll email your signing link to your inbox shortly.</p>
          </>
        ) : (
          <>
            <div className="pay__spinner" />
            <p className="pay__deed-note">Your Deed of Guarantee is on its way to your email for signature. Preparing your signing link&hellip;</p>
          </>
        )}
        {!deedSettled && <p className="pay__muted">You can safely close this page &mdash; we&rsquo;ll email your signing link too.</p>}
      </div>
    </Frame>
  );
}
