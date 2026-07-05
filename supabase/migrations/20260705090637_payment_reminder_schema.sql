-- INCIDENT #1: the automated payment reminder for stuck-at-Sent applications was
-- never built (only deed-EXPIRY reminders and a MANUAL resend existed), so the
-- "8am payment-reminder cron" never fired because nothing was scheduled. This adds
-- the missing system: a per-application per-threshold ledger for exactly-once
-- firing, plus fire_payment_reminders, mirroring the expiry-reminder design.
--
-- Cadence: a reminder at 2, 5 and 9 days after the application was Sent while the
-- guarantor fee is still unpaid (status = 'sent', not refunded). Bounded (max 3
-- nudges). Once Paid, Refunded or Withdrawn the application leaves the 'sent' set
-- and is never reminded again.
create table if not exists public.payment_reminders (
  application_id uuid not null references public.applications(id) on delete cascade,
  threshold text not null,            -- '2' | '5' | '9' (days-since-sent bucket)
  days_at_send int not null,
  sent_at timestamptz not null default now(),
  primary key (application_id, threshold)
);
alter table public.payment_reminders enable row level security;
-- Service-role only: no policies, so anon/authenticated are blocked by RLS.

create or replace function public.fire_payment_reminders(p_today date)
  returns table (
    application_id uuid, guarantee_ref text, days int,
    tenant_title text, tenant_last_name text, tenant_email text,
    prop_addr1 text, prop_postcode text, monthly_rent numeric, payment_url text,
    agency text, branch text, referrer_email text, partner_id uuid
  )
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare r record; k text; d int;
begin
  for r in
    select a.id, a.guarantee_ref, (p_today - a.sent_at::date) as age,
           a.tenant_title, a.tenant_last_name, a.tenant_email, a.prop_addr1, a.prop_postcode,
           a.monthly_rent, a.payment_url, a.partner_id,
           ag.name as agency_name, br.name as branch_name, u.email as ref_email
    from public.applications a
    left join public.branches br on br.id = a.branch_id
    left join public.agencies ag on ag.id = a.agency_id
    left join public.users u on u.id = a.referrer_id
    where a.status = 'sent'
      and coalesce(a.payment_state, '') <> 'refunded'
      and a.payment_url is not null
      and a.sent_at is not null
      and (p_today - a.sent_at::date) >= 2
  loop
    d := r.age;
    -- Only the highest reached threshold fires (so a long-stuck app first seen at
    -- day 21 gets one reminder, not a backlog of all three).
    k := case when d >= 9 then '9' when d >= 5 then '5' else '2' end;
    insert into public.payment_reminders (application_id, threshold, days_at_send)
      values (r.id, k, d) on conflict do nothing;
    if not found then continue; end if; -- already sent this threshold: skip
    insert into public.activity_log (application_id, kind, message, actor, visibility)
      values (r.id, 'payment_reminder',
        'Payment reminder sent to the tenant: guarantor fee still unpaid ' || d || ' days after the application was sent.',
        'System', 'business');
    application_id := r.id; guarantee_ref := r.guarantee_ref; days := d;
    tenant_title := r.tenant_title; tenant_last_name := r.tenant_last_name; tenant_email := r.tenant_email;
    prop_addr1 := r.prop_addr1; prop_postcode := r.prop_postcode; monthly_rent := r.monthly_rent; payment_url := r.payment_url;
    agency := r.agency_name; branch := r.branch_name; referrer_email := r.ref_email; partner_id := r.partner_id;
    return next;
  end loop;
end $function$;

revoke all on function public.fire_payment_reminders(date) from public, anon, authenticated;
grant execute on function public.fire_payment_reminders(date) to service_role;
