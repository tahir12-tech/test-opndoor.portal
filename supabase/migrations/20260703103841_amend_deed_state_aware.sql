-- Deed-state-aware amend boundary. An owning Referrer may amend tenancy start
-- while Paid-but-unexecuted (deed_state <> 'executed'); once the deed is executed
-- (status 'deed' / deed_state 'executed') amends are Management/opndoor-admin only.
-- The deed lifecycle on amend (void+regenerate while awaiting, archive+replace
-- once executed) is orchestrated by the amend-tenancy-start Edge Function; this
-- function enforces the permission and updates the date (expiry_date is a
-- generated column and follows automatically).

drop function if exists public.can_amend_tenancy_start(text, text, boolean);

create function public.can_amend_tenancy_start(p_role text, p_status text, p_owned boolean, p_deed_state text default null)
  returns boolean language sql immutable set search_path to '' as $$
  select case
    when p_status = 'deed' or p_deed_state = 'executed'
      then p_role in ('superadmin', 'management')
    else (case when p_role = 'referrer' then p_owned else true end)
  end
$$;

revoke all on function public.can_amend_tenancy_start(text, text, boolean, text) from public;
grant execute on function public.can_amend_tenancy_start(text, text, boolean, text) to authenticated, service_role;

create or replace function public.amend_tenancy_start(p_app uuid, p_new_start date)
  returns public.applications
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare a public.applications; r text; owned boolean;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if p_new_start is null then raise exception 'A new tenancy start date is required' using errcode = '22023'; end if;
  if p_new_start < date '2000-01-01' or p_new_start > (current_date + interval '5 years')::date then
    raise exception 'Tenancy start date is out of range' using errcode = '22023';
  end if;
  select * into a from public.applications where id = p_app;
  if not found then raise exception 'application not found'; end if;
  r := public.app_role();
  owned := a.referrer_id = auth.uid();
  if not (public.is_admin()
          or (r = 'management' and a.partner_id = public.app_partner())
          or (r = 'referrer'   and owned)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not public.can_amend_tenancy_start(r, a.status, owned, a.deed_state) then
    raise exception 'amend not permitted for this role and status' using errcode = '42501';
  end if;
  -- Date only. expiry_date is generated from tenancy_start; the deed lifecycle is
  -- handled by the amend-tenancy-start Edge Function, not here.
  update public.applications set tenancy_start = p_new_start where id = p_app returning * into a;
  return a;
end $function$;
