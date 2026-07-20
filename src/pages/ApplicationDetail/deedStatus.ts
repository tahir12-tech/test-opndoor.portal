export type DeedStatusViewModel = {
  paymentState?: string | null;
  deedState?: string | null;
};

export function shouldShowAwaitingTenantSignature(status: string, payment?: DeedStatusViewModel | null): boolean {
  if (!payment) return false;
  if (payment.paymentState === 'refunded') return false;
  return status === 'paid' && payment.deedState === 'awaiting_tenant';
}
