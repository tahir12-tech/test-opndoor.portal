-- #1 Tokenised public payment confirmation page. One long-lived, application-scoped
-- token per application (reused across the payment email + all reminders), looked up
-- by the public /pay page via the payment-page edge function (service role). #14 The
-- same token scopes the tenant self-decline action.
create table if not exists public.payment_page_tokens (
  token uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.applications(id) on delete cascade,
  guarantee_ref text not null,
  expires_at timestamptz not null,
  first_viewed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.payment_page_tokens enable row level security;
-- No policies: only the service_role (edge functions / SECURITY DEFINER) touches it.

-- Idempotent mint: one token per application, expiry refreshed to +90 days on each
-- email send so the link outlives the reminder window and any late-payment reinstate.
create or replace function public.mint_payment_page_token(p_ref text)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare v_token uuid;
begin
  insert into public.payment_page_tokens(application_id, guarantee_ref, expires_at)
  select a.id, a.guarantee_ref, now() + interval '90 days'
  from public.applications a where a.guarantee_ref = p_ref
  on conflict (application_id) do update set expires_at = excluded.expires_at
  returning token into v_token;
  return v_token;
end $function$;
revoke execute on function public.mint_payment_page_token(text) from public, anon, authenticated;
grant execute on function public.mint_payment_page_token(text) to service_role;

-- #14 Tenant self-decline, token-scoped and idempotent. Only a Sent application can
-- be declined; it moves to Withdrawn flagged withdrawn_by_tenant (so a later payment
-- reinstates it, item 13's rule). Returns the resulting status so the page can render
-- the right courteous confirmation. Reasons map to the shared withdrawn_reason set.
create or replace function public.decline_application_by_token(p_token uuid, p_reason text)
returns text language plpgsql security definer set search_path to '' as $function$
declare t public.payment_page_tokens; a public.applications; lbl text;
begin
  select * into t from public.payment_page_tokens where token = p_token and expires_at > now();
  if not found then raise exception 'invalid or expired token' using errcode = '22023'; end if;
  select * into a from public.applications where id = t.application_id;
  if not found then raise exception 'application not found'; end if;
  -- Idempotent / non-applicable: only a Sent application declines; everything else
  -- (already declined, paid, deed, expired) returns its current status unchanged.
  if a.status <> 'sent' then return a.status; end if;
  if p_reason is null or p_reason not in ('another_guarantor','tenancy_fell_through','other') then
    p_reason := 'other';
  end if;
  update public.applications
    set status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = p_reason,
        withdrawn_by_tenant = true, withdrawn_by = null
    where id = a.id;
  lbl := case p_reason
           when 'another_guarantor' then 'found another guarantor'
           when 'tenancy_fell_through' then 'tenancy fell through'
           else 'other' end;
  insert into public.activity_log(application_id, kind, message, actor, visibility)
  values (a.id, 'withdrawn',
    'Application withdrawn by the tenant (' || lbl || '). No payment was taken.', 'Tenant', 'business');
  return 'withdrawn';
end $function$;
revoke execute on function public.decline_application_by_token(uuid, text) from public, anon, authenticated;
grant execute on function public.decline_application_by_token(uuid, text) to service_role;