-- #13 Auto-expiry: applications at Sent auto-expire 14 days after sent_at if unpaid.
-- New terminal status 'expired', mirroring 'withdrawn' (excluded from conversion
-- denominators, stuck-at-Sent, reminders, Leagues). A later payment REINSTATES to
-- Paid (late money wins). #14 A tenant-DECLINED withdrawal (withdrawn_by_tenant)
-- reinstates the same way; a staff withdrawal stays an anomaly.
alter table public.applications add column if not exists expired_at timestamptz;
alter table public.applications add column if not exists withdrawn_by_tenant boolean not null default false;

alter table public.applications drop constraint if exists applications_status_check;
alter table public.applications add constraint applications_status_check
  check (status = any (array['sent','paid','deed','withdrawn','expired']));
alter table public.applications drop constraint if exists applications_status_dates;
alter table public.applications add constraint applications_status_dates
  check ((status = 'sent')
      or (status = 'withdrawn' and paid_at is null)
      or (status = 'expired' and paid_at is null)
      or (status = 'paid' and paid_at is not null)
      or (status = 'deed' and paid_at is not null and deed_issued_at is not null));

-- Daily sweep (ridden by the payment-reminders cron). Expires unpaid Sent apps
-- older than 14 days, logs each, returns the count.
create or replace function public.expire_stale_applications(p_today date)
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare n integer;
begin
  with expired as (
    update public.applications
      set status = 'expired', expired_at = now()
      where status = 'sent'
        and sent_at is not null
        and sent_at < (p_today::timestamptz - interval '14 days')
      returning id
  ),
  logged as (
    insert into public.activity_log(application_id, kind, message, actor, visibility)
    select id, 'expired', 'Application expired: guarantor fee unpaid 14 days after referral.', 'System', 'business'
    from expired
    returning 1
  )
  select count(*) into n from logged;
  return coalesce(n, 0);
end $function$;
revoke execute on function public.expire_stale_applications(date) from public, anon, authenticated;
grant execute on function public.expire_stale_applications(date) to service_role;

-- A payment landing on an EXPIRED app, or on a TENANT-DECLINED withdrawal,
-- reinstates it to Paid (late money always wins). A staff withdrawal stays an
-- anomaly (post-payment exits are the refund flow).
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
      status = 'paid', paid_at = coalesce(paid_at, now()),
      stripe_payment_intent_id   = coalesce(p_payment_intent, stripe_payment_intent_id),
      stripe_checkout_session_id = coalesce(p_session_id, stripe_checkout_session_id),
      paid_amount   = coalesce(p_amount, paid_amount), payment_state = 'paid'
    where id = p_application_id;
  elsif a.status = 'expired' or (a.status = 'withdrawn' and a.withdrawn_by_tenant) then
    -- Late money wins: reinstate the closed application to Paid.
    update public.applications set
      status = 'paid', paid_at = coalesce(paid_at, now()),
      stripe_payment_intent_id   = coalesce(p_payment_intent, stripe_payment_intent_id),
      stripe_checkout_session_id = coalesce(p_session_id, stripe_checkout_session_id),
      paid_amount   = coalesce(p_amount, paid_amount), payment_state = 'paid'
    where id = p_application_id;
    insert into public.activity_log(application_id, kind, message, actor, visibility)
    values (p_application_id, 'payment_reinstated',
      'Guarantor fee paid after ' || a.status || '; application reinstated to Paid.', 'System', 'business');
  elsif a.status = 'withdrawn' then
    -- Staff withdrawal: record the intent but do NOT flip to paid; flag for refund.
    update public.applications set
      stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
      stripe_checkout_session_id = coalesce(stripe_checkout_session_id, p_session_id)
    where id = p_application_id;
    insert into public.activity_log(application_id, kind, message, actor, visibility)
    values (p_application_id, 'payment_anomaly',
      'Guarantor fee paid on a WITHDRAWN application. Review and refund required.', 'System', 'business');
  else
    update public.applications set
      stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
      paid_amount   = coalesce(paid_amount, p_amount),
      payment_state = coalesce(payment_state, 'paid')
    where id = p_application_id;
  end if;
end $$;