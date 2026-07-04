-- #72: an agency must always keep at least one contact so its deeds (and the
-- branches that inherit its default) always have a delivery address. Refuse to
-- delete the sole agency contact server-side; the UI blocks it too. Branch
-- contacts are unaffected (a branch with none falls back to the agency default).
create or replace function public.org_remove_contact(p_id uuid) returns void
language plpgsql security definer set search_path to ''
as $function$
declare pid uuid; a_id uuid; n int;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select partner_id, agency_id into pid, a_id from public.agent_contacts where id = p_id;
  if pid is null then raise exception 'Contact not found.' using errcode = '22023'; end if;
  if not (public.is_admin() or (public.app_role() = 'management' and pid = public.app_partner())) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if a_id is not null then
    select count(*) into n from public.agent_contacts where agency_id = a_id;
    if n <= 1 then
      raise exception 'This is the agency''s only contact. Add a replacement contact before removing it.' using errcode = '22023';
    end if;
  end if;
  -- agent_contacts_promote_on_delete promotes the oldest remaining if the
  -- deleted contact was the owner's primary.
  delete from public.agent_contacts where id = p_id;
end $function$;
