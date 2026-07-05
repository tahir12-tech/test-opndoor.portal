-- #2 Take the guarantee_ref (as the client holds it) rather than the uuid, matching
-- how the payment/deed paths resolve an application. Drop the uuid overload so the
-- text-ref signature is unambiguous.
drop function if exists public.mark_withdrawn(uuid, text, text);

create or replace function public.mark_withdrawn(p_ref text, p_reason text, p_note text)
returns public.applications
language plpgsql security definer set search_path to ''
as $function$
declare a public.applications; r text; owned boolean; who text; lbl text;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into a from public.applications where guarantee_ref = p_ref;
  if not found then raise exception 'application not found'; end if;
  r := public.app_role();
  owned := a.referrer_id = auth.uid();
  if not (public.is_admin() or (r = 'management' and a.partner_id = public.app_partner()) or (r = 'referrer' and owned)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if a.status <> 'sent' then raise exception 'Only an application at Sent (before payment) can be withdrawn.' using errcode = '42501'; end if;
  if p_reason not in ('another_guarantor','tenancy_fell_through','duplicate','other') then
    raise exception 'Invalid withdrawal reason' using errcode = '22023';
  end if;
  if p_reason = 'other' and coalesce(btrim(p_note), '') = '' then
    raise exception 'A note is required when the reason is Other.' using errcode = '22023';
  end if;
  update public.applications
    set status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = p_reason,
        withdrawn_note = nullif(btrim(coalesce(p_note,'')), ''), withdrawn_by = auth.uid()
    where id = a.id returning * into a;
  who := coalesce((select full_name from public.users where id = auth.uid()), 'a user');
  lbl := case p_reason
           when 'another_guarantor' then 'tenant found another guarantor'
           when 'tenancy_fell_through' then 'tenancy fell through'
           when 'duplicate' then 'duplicate referral'
           else 'other' end;
  insert into public.activity_log(application_id, kind, message, actor, visibility)
  values (a.id, 'withdrawn',
    'Application withdrawn (' || lbl || ')' || case when a.withdrawn_note is not null then ': ' || a.withdrawn_note else '' end || '.',
    who, 'business');
  return a;
end $function$;
revoke execute on function public.mark_withdrawn(text, text, text) from public, anon;
grant execute on function public.mark_withdrawn(text, text, text) to authenticated, service_role;
