/* =====================================================================
   #1 Public tenant payment confirmation page (/pay?token=...). The only client
   calls to the unauthenticated payment-page Edge Function (view / checkout /
   decline), keyed to an application-scoped token. Mock/test mode returns a
   deterministic demo so the page renders with no back end (smoke test passes).
   ===================================================================== */
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';

export interface PayPageData {
  ok: boolean;
  ref?: string;
  partnerName?: string;
  tenantName?: string;
  tenantTitle?: string;
  addr1?: string;
  postcode?: string;
  propFull?: string;
  tenancyStart?: string | null;
  guaranteeExpiry?: string | null;
  monthlyRent?: number;
  feeGBP?: string;
  status?: string;
  isPaid?: boolean;
  isExpired?: boolean;
  isClosed?: boolean;
  payable?: boolean;
  /** True on a network / 5xx / 429 blip — keep the prior state, never a hard error. */
  transient?: boolean;
  error?: string;
}

export function getPayPageState(status: string | null | undefined, paymentState: string | null | undefined) {
  const normalizedStatus = status ?? '';
  const normalizedPaymentState = paymentState ?? '';
  const isRefunded = normalizedPaymentState === 'refunded';
  const isPaid = !isRefunded && (normalizedStatus === 'paid' || normalizedStatus === 'deed' || normalizedPaymentState === 'paid');
  const isExpired = normalizedStatus === 'expired';
  const isClosed = normalizedStatus === 'withdrawn' || isRefunded;
  const payable = !isRefunded && (normalizedStatus === 'sent' || normalizedStatus === 'expired');
  return { isPaid, isExpired, isClosed, payable };
}

const DEMO: PayPageData = {
  ok: true, ref: 'GR-20608', partnerName: 'Rightmove', tenantName: 'Mr Alex Turner', tenantTitle: 'Mr',
  addr1: '12 Sydney Street', postcode: 'SW3 6PU', propFull: '12 Sydney Street, London, SW3 6PU',
  tenancyStart: '01/09/2026', guaranteeExpiry: '31/08/2027', monthlyRent: 2200, feeGBP: '£2,200',
  status: 'sent', isPaid: false, isExpired: false, isClosed: false, payable: true,
};

/** Load the public-safe payment data for a token (also logs the first view). */
export async function getPayPage(token: string): Promise<PayPageData> {
  if (!SUPABASE_ENABLED) return DEMO;
  try {
    const { data, error } = await sb().functions.invoke('payment-page', { body: { token, action: 'view' } });
    if (error) return { ok: false, transient: true, error: 'network' };
    return (data ?? { ok: false, transient: true }) as PayPageData;
  } catch {
    return { ok: false, transient: true, error: 'network' };
  }
}

/** Create a fresh Stripe Checkout session and return its URL to redirect to. */
export async function startCheckout(token: string, utm: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!SUPABASE_ENABLED) return { ok: false, error: 'Payments are not available in preview mode.' };
  try {
    const { data, error } = await sb().functions.invoke('payment-page', { body: { token, action: 'checkout', utm_source: utm } });
    if (error) return { ok: false, error: 'We could not start the payment. Please try again.' };
    return (data ?? { ok: false }) as { ok: boolean; url?: string; error?: string };
  } catch {
    return { ok: false, error: 'We could not start the payment. Please try again.' };
  }
}

/** #14 Record a tenant self-decline; returns the resulting application status. */
export async function declineApplication(token: string, reason: string): Promise<{ ok: boolean; status?: string; error?: string }> {
  if (!SUPABASE_ENABLED) return { ok: true, status: 'withdrawn' };
  try {
    const { data, error } = await sb().functions.invoke('payment-page', { body: { token, action: 'decline', reason } });
    if (error) return { ok: false, error: 'Could not record that. Please contact hello@opndoor.co.' };
    return (data ?? { ok: false }) as { ok: boolean; status?: string; error?: string };
  } catch {
    return { ok: false, error: 'Could not record that. Please contact hello@opndoor.co.' };
  }
}
