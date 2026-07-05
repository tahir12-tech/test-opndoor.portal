-- Review fix (#14): a tenant on an EXPIRED link who confirms "no longer need this"
-- previously got a success message while nothing was recorded (decline only acted on
-- status='sent'). An expired application is still shown as payable, so it must also be
-- declinable: record a tenant-declined withdrawal (audited), which a later payment
-- still reinstates (withdrawn_by_tenant). Paid/deed/already-withdrawn stay no-ops.
create or replace function public.decline_application_by_token(p_token uuid, p_reason text)
returns text language plpgsql security definer set search_path to '' as $function$
declare t public.payment_page_tokens; a public.applications; lbl text;
begin
  select * into t from public.payment_page_tokens where token = p_token and expires_at > now();
  if not found then raise exception 'invalid or expired token' using errcode = '22023'; end if;
  select * into a from public.applications where id = t.application_id;
  if not found then raise exception 'application not found'; end if;
  -- Only an open referral (Sent or auto-Expired) can be declined; anything else
  -- (already declined, paid, deed) returns its current status unchanged.
  if a.status not in ('sent', 'expired') then return a.status; end if;
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
    'Application withdrawn by the tenant (' || lbl || ')' || case when a.status = 'expired' then ', from an expired link' else '' end || '. No payment was taken.', 'Tenant', 'business');
  return 'withdrawn';
end $function$;
revoke execute on function public.decline_application_by_token(uuid, text) from public, anon, authenticated;
grant execute on function public.decline_application_by_token(uuid, text) to service_role;
