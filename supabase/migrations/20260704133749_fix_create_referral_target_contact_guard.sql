-- Security fix: capture a contact ONLY for an entity created in THIS call. The
-- previous version guarded the agency contact (no-overwrite) but left the branch
-- contact insert unguarded, so a direct RPC call against an existing branch could
-- insert a new primary contact (the maintain-primary trigger demoting the real
-- one) and redirect deed delivery. Gating on ag_new/br_new closes that vector and
-- matches the intent (contact capture is for inline creation only).
create or replace function public.create_referral_target(
  p_agency text, p_branch text,
  p_agency_email text default null, p_agency_contact_name text default null, p_agency_phone text default null,
  p_branch_email text default null, p_branch_contact_name text default null, p_branch_phone text default null
) returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare pid uuid; me uuid := auth.uid(); who text; ag_id uuid; br_id uuid; ag_new boolean := false; br_new boolean := false;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  pid := public.app_partner();
  if pid is null then
    raise exception 'Creating an agency or branch on the fly is only available to partner users; opndoor admins should pick an existing branch.' using errcode = '42501';
  end if;
  if btrim(coalesce(p_agency,'')) = '' or btrim(coalesce(p_branch,'')) = '' then
    raise exception 'Agency and branch are required' using errcode = '22023';
  end if;

  who := coalesce((select full_name from public.users where id = me), 'a referrer');

  select id into ag_id from public.agencies where partner_id = pid and lower(name) = lower(btrim(p_agency)) limit 1;
  if ag_id is null then
    insert into public.agencies(name, partner_id, review_state, created_by)
    values (btrim(p_agency), pid, 'pending_review', me) returning id into ag_id;
    ag_new := true;
    insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
    values ('agency', ag_id, 'created', btrim(p_agency), who, me);
  end if;

  select id into br_id from public.branches where agency_id = ag_id and lower(name) = lower(btrim(p_branch)) limit 1;
  if br_id is null then
    insert into public.branches(name, agency_id, partner_id, review_state, created_by)
    values (btrim(p_branch), ag_id, pid, 'pending_review', me) returning id into br_id;
    br_new := true;
    insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
    values ('branch', br_id, 'created', btrim(p_branch), who, me);
  end if;

  -- Agency-default contact: only for an agency created in this call (a fresh agency
  -- has no contacts, so this can never overwrite an existing primary).
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
