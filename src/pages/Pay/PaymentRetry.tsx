/* =====================================================================
   /pay/retry — the tenant lands here from Stripe when they cancel/abandon
   checkout (cancel_url). Public, unauthenticated, opndoor-branded. Shows what
   is still owed and offers a single "Return to payment" button back to their
   Stripe checkout link. If the fee is in fact already paid, it forwards to the
   confirmation page.
   ===================================================================== */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '@/components/ui/Icon';
import { PayFrame as Frame } from './PayFrame';
import { getPaymentConfirmation, fmtAmount, type PaymentConfirmation } from './paymentApi';

export function PaymentRetry() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const sessionId = params.get('session_id') ?? '';
  const [conf, setConf] = useState<PaymentConfirmation | null>(null);

  useEffect(() => {
    if (!sessionId) { setConf({ found: false }); return; }
    let cancelled = false;
    getPaymentConfirmation(sessionId).then((c) => {
      if (cancelled) return;
      if (c.paid) { navigate(`/pay/confirmed?session_id=${encodeURIComponent(sessionId)}`, { replace: true }); return; }
      setConf(c);
    });
    return () => { cancelled = true; };
  }, [sessionId, navigate]);

  if (conf === null) {
    return <Frame><div className="pay__spinner" /><p className="pay__lead">One moment&hellip;</p></Frame>;
  }

  if (!conf.found) {
    return (
      <Frame>
        <div className="pay__icon pay__icon--warn"><Icon name="alert" strokeWidth={2} /></div>
        <h1 className="pay__title">Payment not completed</h1>
        <p className="pay__lead">Please use the payment link in your email to complete your guarantor fee.</p>
      </Frame>
    );
  }

  return (
    <Frame>
      <div className="pay__icon pay__icon--wait"><Icon name="clock" strokeWidth={2} /></div>
      <h1 className="pay__title">Payment not completed</h1>
      <p className="pay__lead">
        No payment was taken{conf.firstName ? `, ${conf.firstName}` : ''}. You can complete your guarantor fee whenever you&rsquo;re ready.
      </p>

      <div className="pay__receipt">
        <div className="pay__rrow"><span className="pay__rk">Amount due</span><span className="pay__rv pay__rv--amt">{fmtAmount(conf.amount)}</span></div>
        <div className="pay__rrow"><span className="pay__rk">Reference</span><span className="pay__rv">{conf.reference}</span></div>
      </div>

      {conf.payUrl ? (
        <a className="pay__btn pay__btn--dark" href={conf.payUrl}><Icon name="lock" strokeWidth={2} /> Return to payment</a>
      ) : (
        <p className="pay__muted">Please use the payment link in your email to complete your payment.</p>
      )}
    </Frame>
  );
}
