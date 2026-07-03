/* =====================================================================
   Public tenant payment pages — the only client calls to the unauthenticated
   payment-confirmation Edge Function. Keyed to the Stripe Checkout session id.
   Mock/test mode returns a deterministic demo so the pages render with no back
   end (and the smoke test passes).
   ===================================================================== */
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';

export interface PaymentConfirmation {
  found: boolean;
  firstName?: string;
  reference?: string;
  amount?: number;
  paid?: boolean;
  deedReady?: boolean;
  deedSigned?: boolean;
  deedError?: boolean;
  /** The tenant's own Stripe checkout link, present only while unpaid (retry). */
  payUrl?: string | null;
  /** True on a network / 5xx / 429 failure: a transient blip, NOT a definitive
      "not found". Callers should keep the prior state and retry, never downgrade
      a confirmed payment to a not-found screen. */
  transient?: boolean;
  error?: string;
}

const DEMO: PaymentConfirmation = {
  found: true, firstName: 'Alex', reference: 'GR-20608', amount: 2200, paid: true, deedReady: true,
};

/** Fetch the minimal confirmation state for a Stripe Checkout session id. */
export async function getPaymentConfirmation(sessionId: string): Promise<PaymentConfirmation> {
  if (!SUPABASE_ENABLED) return DEMO;
  try {
    const { data, error } = await sb().functions.invoke('payment-confirmation', { body: { session_id: sessionId } });
    // A non-2xx (5xx, 429) or network error is transient — never a definitive
    // "not found". Only a real 200 body with { found: false } is definitive.
    if (error) return { found: false, transient: true, error: 'network' };
    return (data ?? { found: false, transient: true }) as PaymentConfirmation;
  } catch {
    return { found: false, transient: true, error: 'network' };
  }
}

/** Mint (on click) and return the PandaDoc signing-session link, or null. */
export async function requestSigningLink(sessionId: string): Promise<string | null> {
  if (!SUPABASE_ENABLED) return 'https://app.pandadoc.com/s/demo';
  try {
    const { data, error } = await sb().functions.invoke('payment-confirmation', { body: { session_id: sessionId, action: 'sign' } });
    if (error || !data) return null;
    return (data as { signingUrl?: string | null }).signingUrl ?? null;
  } catch {
    return null;
  }
}

/** £ amount, pence only when present. */
export function fmtAmount(n: number | undefined): string {
  if (n == null) return '';
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
