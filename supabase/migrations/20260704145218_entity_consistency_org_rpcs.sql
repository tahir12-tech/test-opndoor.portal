-- ============================================================================
-- Entity consistency: unblock admin fly-creation and give the Agencies-screen
-- forms real, gated persistence (no more localStorage-only phantoms).
-- ============================================================================

-- 1. create_referral_target: opndoor admins may now fly-create (their records
--    land 'confirmed' - the admin creation IS the review). Partner users are
--    unchanged (records land 'pending_review'). An admin resolves the partner
--    from the existing agency, or from an explicit slug for a brand-new agency.
--    The created-in-call contact-injection gates (ag_new / br_new) are retained.
drop function if exists public.create_referral_target(text, text, text, text, text, text, text, text);

create or replace function public.create_referral_target(
  p_agency text, p_branch text,
  p_agency_email text default null, p_agency_contact_name text default null, p_agency_phone text default null,
  p_branch_email text default null, p_branch_contact_name text default null, p_branch_phone text default null,
  p_partner_slug text default null
) returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  pid uuid; me uuid := auth.uid(); who text;
  ag_id uuid; br_id uuid; ag_new boolean := false; br_new boolean := false;
  v_admin boolean := public.is_admin();
  v_state text;
  v_slug text := nullif(btrim(coalesce(p_partner_slug,'')), '');
  v_slug_id uuid;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if btrim(coalesce(p_agency,'')) = '' or btrim(coalesce(p_branch,'')) = '' then
    raise exception 'Agency and branch are required' using errcode = '22023';
  end if;

  who := coalesce((select full_name from public.users where id = me), 'a referrer');
  pid := public.app_partner();

  if pid is not null then
    -- Partner user: their own partner; on-the-fly records are pending review.
    v_state := 'pending_review';
    select id into ag_id from public.agencies
      where partner_id = pid and lower(name) = lower(btrim(p_agency)) limit 1;
  else
    -- opndoor admin: creations ARE the review (confirmed). Resolve the partner.
    if not v_admin then
      raise exception 'Not permitted.' using errcode = '42501';
    end if;
    v_state := 'confirmed';
    if v_slug is not null then
      select id into v_slug_id from public.partners where slug = v_slug;
    end if;
    select a.id, a.partner_id into ag_id, pid
      from public.agencies a
      where lower(a.name) = lower(btrim(p_agency))
        and (v_slug_id is null or a.partner_id = v_slug_id)
      order by (a.review_state = 'confirmed') desc, a.created_at asc
      limit 1;
    if ag_id is null then
      if v_slug is null then
        raise exception 'Select a specific partner before creating a new agency on the fly.' using errcode = '22023';
      end if;
      if v_slug_id is null then
        raise exception 'Unknown partner.' using errcode = '22023';
      end if;
      pid := v_slug_id;
    end if;
  end if;

  if ag_id is null then
    insert into public.agencies(name, partner_id, review_state, created_by)
    values (btrim(p_agency), pid, v_state, me) returning id into ag_id;
    ag_new := true;
    insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
    values ('agency', ag_id, 'created', btrim(p_agency), who, me);
  end if;

  select id into br_id from public.branches
    where agency_id = ag_id and lower(name) = lower(btrim(p_branch)) limit 1;
  if br_id is null then
    insert into public.branches(name, agency_id, partner_id, review_state, created_by)
    values (btrim(p_branch), ag_id, pid, v_state, me) returning id into br_id;
    br_new := true;
    insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
    values ('branch', br_id, 'created', btrim(p_branch), who, me);
  end if;

  -- Agency-default contact: only for an agency created in this call.
  if ag_new and coalesce(btrim(p_agency_email),'') <> '' then
    insert into public.agent_contacts(agency_id, partner_id, name, email, phone, is_primary, created_by)
    values (ag_id, pid, coalesce(nullif(btrim(p_agency_contact_name),''), btrim(p_agency_email)), btrim(p_agency_email), nullif(btrim(p_agency_phone),''), true, me);
  end if;

  -- Optional branch contact: only for a branch created in this call.
  if br_new and coalesce(btrim(p_branch_email),'') <> '' then
    insert into public.agent_contacts(branch_id, partner_id, name, email, phone, is_primary, created_by)
    values (br_id, pid, coalesce(nullif(btrim(p_branch_contact_name),''), btrim(p_branch_email)), btrim(p_branch_email), nullif(btrim(p_branch_phone),''), true, me);
  end if;

  return br_id;
end $function$;

revoke all on function public.create_referral_target(text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_referral_target(text, text, text, text, text, text, text, text, text) to authenticated;

-- 2. Agencies-screen: add an agency with a REQUIRED default contact (no bare
--    agencies). Admin -> confirmed; management -> pending_review.
create or replace function public.admin_add_agency(
  p_name text, p_group text default null, p_partner_slug text default null,
  p_contact_email text default null, p_contact_name text default null, p_contact_phone text default null
) returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  me uuid := auth.uid(); who text; pid uuid; ag_id uuid;
  v_admin boolean := public.is_admin();
  v_state text; v_slug text := nullif(btrim(coalesce(p_partner_slug,'')),''); v_email text := btrim(coalesce(p_contact_email,''));
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if not (v_admin or public.app_role() = 'management') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name,'')) = '' then raise exception 'Agency name is required' using errcode = '22023'; end if;
  if v_email = '' then raise exception 'An agency contact email is required.' using errcode = '22023'; end if;
  if v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then raise exception 'Enter a valid agency contact email.' using errcode = '22023'; end if;

  pid := public.app_partner();
  if pid is null then
    if v_slug is null then raise exception 'Select a specific partner before adding an agency.' using errcode = '22023'; end if;
    select id into pid from public.partners where slug = v_slug;
    if pid is null then raise exception 'Unknown partner.' using errcode = '22023'; end if;
  end if;
  v_state := case when v_admin then 'confirmed' else 'pending_review' end;

  if exists (select 1 from public.agencies where partner_id = pid and lower(name) = lower(btrim(p_name))) then
    raise exception 'An agency with that name already exists for this partner.' using errcode = '23505';
  end if;

  who := coalesce((select full_name from public.users where id = me), 'an administrator');
  insert into public.agencies(name, group_name, partner_id, review_state, created_by)
  values (btrim(p_name), nullif(btrim(coalesce(p_group,'')),''), pid, v_state, me) returning id into ag_id;
  insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
  values ('agency', ag_id, 'created', btrim(p_name), who, me);

  insert into public.agent_contacts(agency_id, partner_id, name, email, phone, is_primary, created_by)
  values (ag_id, pid, coalesce(nullif(btrim(p_contact_name),''), v_email), v_email, nullif(btrim(p_contact_phone),''), true, me);

  return ag_id;
end $function$;

revoke all on function public.admin_add_agency(text, text, text, text, text, text) from public, anon;
grant execute on function public.admin_add_agency(text, text, text, text, text, text) to authenticated;

-- 3. Agencies-screen: add a branch. Contact optional; blank inherits the agency
--    default. Admin -> confirmed; management -> pending_review.
create or replace function public.admin_add_branch(
  p_agency_id uuid, p_name text, p_area text default null,
  p_contact_email text default null, p_contact_name text default null, p_contact_phone text default null
) returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  me uuid := auth.uid(); who text; pid uuid; br_id uuid; v_admin boolean := public.is_admin(); v_state text; v_email text := btrim(coalesce(p_contact_email,''));
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if btrim(coalesce(p_name,'')) = '' then raise exception 'Branch name is required' using errcode = '22023'; end if;
  select partner_id into pid from public.agencies where id = p_agency_id;
  if pid is null then raise exception 'Agency not found.' using errcode = '22023'; end if;
  if not (v_admin or (public.app_role() = 'management' and pid = public.app_partner())) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if v_email <> '' and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'Enter a valid branch contact email, or leave it blank.' using errcode = '22023';
  end if;
  v_state := case when v_admin then 'confirmed' else 'pending_review' end;

  if exists (select 1 from public.branches where agency_id = p_agency_id and lower(name) = lower(btrim(p_name))) then
    raise exception 'A branch with that name already exists for this agency.' using errcode = '23505';
  end if;

  who := coalesce((select full_name from public.users where id = me), 'an administrator');
  insert into public.branches(name, agency_id, partner_id, area, review_state, created_by)
  values (btrim(p_name), p_agency_id, pid, nullif(btrim(coalesce(p_area,'')),''), v_state, me) returning id into br_id;
  insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
  values ('branch', br_id, 'created', btrim(p_name), who, me);

  if v_email <> '' then
    insert into public.agent_contacts(branch_id, partner_id, name, email, phone, is_primary, created_by)
    values (br_id, pid, coalesce(nullif(btrim(p_contact_name),''), v_email), v_email, nullif(btrim(p_contact_phone),''), true, me);
  end if;

  return br_id;
end $function$;

revoke all on function public.admin_add_branch(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.admin_add_branch(uuid, text, text, text, text, text) to authenticated;

-- 4. Contact: add to exactly one agency or branch. First contact is forced
--    primary; an explicit primary clears the others for that owner.
create or replace function public.org_add_contact(
  p_agency_id uuid, p_branch_id uuid,
  p_name text, p_role text, p_email text, p_phone text, p_primary boolean default false
) returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare me uuid := auth.uid(); pid uuid; new_id uuid; v_email text := btrim(coalesce(p_email,'')); n int;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if (p_agency_id is null) = (p_branch_id is null) then
    raise exception 'A contact must belong to exactly one agency or branch.' using errcode = '22023';
  end if;
  if btrim(coalesce(p_name,'')) = '' or v_email = '' then
    raise exception 'Contact name and email are required.' using errcode = '22023';
  end if;
  if v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'Enter a valid contact email.' using errcode = '22023';
  end if;
  if p_agency_id is not null then select partner_id into pid from public.agencies where id = p_agency_id;
  else select partner_id into pid from public.branches where id = p_branch_id; end if;
  if pid is null then raise exception 'Owner not found.' using errcode = '22023'; end if;
  if not (public.is_admin() or (public.app_role() = 'management' and pid = public.app_partner())) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  select count(*) into n from public.agent_contacts
    where (p_agency_id is not null and agency_id = p_agency_id)
       or (p_branch_id is not null and branch_id = p_branch_id);
  if n = 0 then p_primary := true; end if;
  if p_primary then
    update public.agent_contacts set is_primary = false
      where ((p_agency_id is not null and agency_id = p_agency_id)
          or (p_branch_id is not null and branch_id = p_branch_id)) and is_primary;
  end if;

  insert into public.agent_contacts(agency_id, branch_id, partner_id, name, email, phone, contact_role, is_primary, created_by)
  values (p_agency_id, p_branch_id, pid, btrim(p_name), v_email, nullif(btrim(coalesce(p_phone,'')),''), nullif(btrim(coalesce(p_role,'')),''), p_primary, me)
  returning id into new_id;
  return new_id;
end $function$;

revoke all on function public.org_add_contact(uuid, uuid, text, text, text, text, boolean) from public, anon;
grant execute on function public.org_add_contact(uuid, uuid, text, text, text, text, boolean) to authenticated;

-- 5. Contact: update by id. Preserves primary; if the edit would leave the
--    owner with no primary, the oldest contact is promoted (invariant kept).
create or replace function public.org_update_contact(
  p_id uuid, p_name text, p_role text, p_email text, p_phone text, p_primary boolean
) returns void
language plpgsql security definer set search_path to ''
as $function$
declare pid uuid; a_id uuid; b_id uuid; v_email text := btrim(coalesce(p_email,'')); has_primary boolean;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select partner_id, agency_id, branch_id into pid, a_id, b_id from public.agent_contacts where id = p_id;
  if pid is null then raise exception 'Contact not found.' using errcode = '22023'; end if;
  if not (public.is_admin() or (public.app_role() = 'management' and pid = public.app_partner())) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name,'')) = '' or v_email = '' then
    raise exception 'Contact name and email are required.' using errcode = '22023';
  end if;
  if v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'Enter a valid contact email.' using errcode = '22023';
  end if;

  if p_primary then
    update public.agent_contacts set is_primary = false
      where ((a_id is not null and agency_id = a_id) or (b_id is not null and branch_id = b_id)) and id <> p_id and is_primary;
  end if;

  update public.agent_contacts
    set name = btrim(p_name), email = v_email, phone = nullif(btrim(coalesce(p_phone,'')),''),
        contact_role = nullif(btrim(coalesce(p_role,'')),''), is_primary = p_primary
    where id = p_id;

  select exists (select 1 from public.agent_contacts
    where ((a_id is not null and agency_id = a_id) or (b_id is not null and branch_id = b_id)) and is_primary) into has_primary;
  if not has_primary then
    update public.agent_contacts set is_primary = true where id = (
      select id from public.agent_contacts
      where (a_id is not null and agency_id = a_id) or (b_id is not null and branch_id = b_id)
      order by created_at asc, id asc limit 1);
  end if;
end $function$;

revoke all on function public.org_update_contact(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function public.org_update_contact(uuid, text, text, text, text, boolean) to authenticated;

-- 6. Contact: remove by id (promotes a new primary if the removed one was it).
create or replace function public.org_remove_contact(p_id uuid) returns void
language plpgsql security definer set search_path to ''
as $function$
declare pid uuid; a_id uuid; b_id uuid; has_primary boolean;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select partner_id, agency_id, branch_id into pid, a_id, b_id from public.agent_contacts where id = p_id;
  if pid is null then raise exception 'Contact not found.' using errcode = '22023'; end if;
  if not (public.is_admin() or (public.app_role() = 'management' and pid = public.app_partner())) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  delete from public.agent_contacts where id = p_id;
  select exists (select 1 from public.agent_contacts
    where ((a_id is not null and agency_id = a_id) or (b_id is not null and branch_id = b_id)) and is_primary) into has_primary;
  if not has_primary then
    update public.agent_contacts set is_primary = true where id = (
      select id from public.agent_contacts
      where (a_id is not null and agency_id = a_id) or (b_id is not null and branch_id = b_id)
      order by created_at asc, id asc limit 1);
  end if;
end $function$;

revoke all on function public.org_remove_contact(uuid) from public, anon;
grant execute on function public.org_remove_contact(uuid) to authenticated;

-- 7. Contact: set a specific contact as the owner's primary.
create or replace function public.org_set_primary_contact(p_id uuid) returns void
language plpgsql security definer set search_path to ''
as $function$
declare pid uuid; a_id uuid; b_id uuid;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select partner_id, agency_id, branch_id into pid, a_id, b_id from public.agent_contacts where id = p_id;
  if pid is null then raise exception 'Contact not found.' using errcode = '22023'; end if;
  if not (public.is_admin() or (public.app_role() = 'management' and pid = public.app_partner())) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  update public.agent_contacts set is_primary = (id = p_id)
    where (a_id is not null and agency_id = a_id) or (b_id is not null and branch_id = b_id);
end $function$;

revoke all on function public.org_set_primary_contact(uuid) from public, anon;
grant execute on function public.org_set_primary_contact(uuid) to authenticated;
