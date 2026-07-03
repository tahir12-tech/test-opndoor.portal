-- Payment fields on applications (test mode Stripe).
alter table public.applications
  add column stripe_checkout_session_id text,
  add column stripe_payment_intent_id   text,
  add column stripe_refund_id           text,
  add column payment_url                 text,
  add column paid_amount                 numeric(10,2),
  add column refunded_at                 timestamptz,
  add column payment_state               text check (payment_state in ('awaiting','paid','refunded'));

-- Webhook event log for idempotency (service role only; no policies).
create table public.stripe_events (
  id           text primary key,      -- Stripe event id (evt_...)
  type         text not null,
  application_id uuid references public.applications(id) on delete set null,
  received_at  timestamptz not null default now()
);
alter table public.stripe_events enable row level security;

-- ---------- service-role transition path used by the webhook ----------
-- set_application_status is AAL2 + admin/management gated, so the service-role
-- webhook (no session) uses this dedicated, idempotent companion instead.
create or replace function public.apply_stripe_payment(
  p_application_id uuid, p_payment_intent text, p_amount numeric, p_session_id text
) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.applications;
begin
  select * into a from public.applications where id = p_application_id;
  if not found then raise exception 'application not found'; end if;
  if a.status = 'sent' then
    update public.applications set
      status = 'paid',
      paid_at = coalesce(paid_at, now()),
      stripe_payment_intent_id   = coalesce(p_payment_intent, stripe_payment_intent_id),
      stripe_checkout_session_id = coalesce(p_session_id, stripe_checkout_session_id),
      paid_amount   = coalesce(p_amount, paid_amount),
      payment_state = 'paid'
    where id = p_application_id;
  else
    -- already advanced: record payment refs without a second transition
    update public.applications set
      stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
      paid_amount   = coalesce(paid_amount, p_amount),
      payment_state = coalesce(payment_state, 'paid')
    where id = p_application_id;
  end if;
end $$;

create or replace function public.apply_stripe_refund(p_payment_intent text, p_refund_id text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Record refund state without reversing the Sent -> Paid transition (by design).
  update public.applications set
    stripe_refund_id = p_refund_id,
    refunded_at      = coalesce(refunded_at, now()),
    payment_state    = 'refunded'
  where stripe_payment_intent_id = p_payment_intent;
end $$;

-- Payment transition functions are for the trusted service role only.
revoke execute on function public.apply_stripe_payment(uuid, text, numeric, text) from public, anon, authenticated;
revoke execute on function public.apply_stripe_refund(text, text) from public, anon, authenticated;
grant execute on function public.apply_stripe_payment(uuid, text, numeric, text) to service_role;
grant execute on function public.apply_stripe_refund(text, text) to service_role;
