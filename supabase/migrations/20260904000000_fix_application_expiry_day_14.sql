-- Fix auto-expiry to run on the 14th day after referral, matching the
-- user-facing wording and the application's 14-day expiry contract.
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
        and (sent_at at time zone 'Europe/London')::date <= (p_today - 14)
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