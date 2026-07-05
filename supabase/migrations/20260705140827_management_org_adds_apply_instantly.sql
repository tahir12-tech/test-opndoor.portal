-- #99 (owner ruling): management are opndoor's customers managing their own estate,
-- so their DELIBERATE additions/edits via the org tool apply instantly (confirmed),
-- never pending_review. Only ON-THE-FLY creations during a referral (the separate
-- create_referral_target path) keep the review flag. Previously admin_add_agency /
-- admin_add_branch set pending_review for management, sending vetted management adds
-- to Reconciliation.
create or replace function public.admin_add_agency(p_name text, p_group text DEFAULT NULL::text, p_partner_slug text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_contact_phone text DEFAULT NULL::text)
 returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  me uuid := auth.uid(); who text; pid uuid; ag_id uuid;
  v_admin boolean := public.is_admin();
  v_slug text := nullif(btrim(coalesce(p_partner_slug,'')),''); v_email text := btrim(coalesce(p_contact_email,''));
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if not (v_admin or public.app_role() = 'management') then raise exception 'Not permitted.' using errcode = '42501'; end if;
  if btrim(coalesce(p_name,'')) = '' then raise exception 'Agency name is required' using errcode = '22023'; end if;
  if v_email = '' then raise exception 'An agency contact email is required.' using errcode = '22023'; end if;
  if v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then raise exception 'Enter a valid agency contact email.' using errcode = '22023'; end if;
  pid := public.app_partner();
  if pid is null then
    if v_slug is null then raise exception 'Select a specific partner before adding an agency.' using errcode = '22023'; end if;
    select id into pid from public.partners where slug = v_slug;
    if pid is null then raise exception 'Unknown partner.' using errcode = '22023'; end if;
  end if;
  -- A deliberate org-tool add by admin OR management lands confirmed (instant).
  if exists (select 1 from public.agencies where partner_id = pid and lower(name) = lower(btrim(p_name))) then
    raise exception 'An agency with that name already exists for this partner.' using errcode = '23505';
  end if;
  who := coalesce((select full_name from public.users where id = me), 'an administrator');
  insert into public.agencies(name, group_name, partner_id, review_state, created_by)
  values (btrim(p_name), nullif(btrim(coalesce(p_group,'')),''), pid, 'confirmed', me) returning id into ag_id;
  insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
  values ('agency', ag_id, 'created', btrim(p_name), who, me);
  insert into public.agent_contacts(agency_id, partner_id, name, email, phone, is_primary, created_by)
  values (ag_id, pid, btrim(coalesce(p_contact_name,'')), v_email, nullif(btrim(p_contact_phone),''), true, me);
  return ag_id;
end $function$;

create or replace function public.admin_add_branch(p_agency_id uuid, p_name text, p_area text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_contact_phone text DEFAULT NULL::text)
 returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  me uuid := auth.uid(); who text; pid uuid; br_id uuid; v_admin boolean := public.is_admin(); v_email text := btrim(coalesce(p_contact_email,''));
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
  -- A deliberate org-tool add by admin OR management lands confirmed (instant).
  if exists (select 1 from public.branches where agency_id = p_agency_id and lower(name) = lower(btrim(p_name))) then
    raise exception 'A branch with that name already exists for this agency.' using errcode = '23505';
  end if;
  who := coalesce((select full_name from public.users where id = me), 'an administrator');
  insert into public.branches(name, agency_id, partner_id, area, review_state, created_by)
  values (btrim(p_name), p_agency_id, pid, nullif(btrim(coalesce(p_area,'')),''), 'confirmed', me) returning id into br_id;
  insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
  values ('branch', br_id, 'created', btrim(p_name), who, me);
  if v_email <> '' then
    insert into public.agent_contacts(branch_id, partner_id, name, email, phone, is_primary, created_by)
    values (br_id, pid, btrim(coalesce(p_contact_name,'')), v_email, nullif(btrim(p_contact_phone),''), true, me);
  end if;
  return br_id;
end $function$;