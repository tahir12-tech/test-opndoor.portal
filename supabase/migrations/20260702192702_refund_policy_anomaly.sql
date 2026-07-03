-- Policy: refunds are only legitimate BEFORE the tenancy start. A refund on or
-- after the tenancy start is a policy anomaly, recorded truthfully and flagged
-- loudly for a human (never blocked or reversed automatically).
alter table public.applications add column refund_after_start boolean not null default false;

-- Backfill existing refunds: anomaly if the tenancy start had been reached at refund time.
update public.applications set refund_after_start = (tenancy_start <= refunded_at::date)
  where payment_state = 'refunded' and refunded_at is not null;

create or replace function public.apply_stripe_refund(p_payment_intent text, p_refund_id text, p_amount numeric default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.applications set
    stripe_refund_id   = p_refund_id,
    refunded_at        = coalesce(refunded_at, now()),
    refunded_amount    = coalesce(p_amount, refunded_amount, paid_amount),
    payment_state      = 'refunded',
    refund_after_start = (tenancy_start <= current_date)
  where stripe_payment_intent_id = p_payment_intent;
end $$;
