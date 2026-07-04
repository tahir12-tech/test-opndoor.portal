-- On-the-fly entity creation + reconciliation plumbing.

-- 1) review_state on agencies + branches (pending_review | confirmed), replacing
--    the old boolean flag. On-the-fly creations are pending_review; everything
--    else is confirmed. It is a review flag, not a gate.
alter table public.agencies add column if not exists review_state text not null default 'confirmed'
  check (review_state in ('pending_review','confirmed'));
alter table public.branches add column if not exists review_state text not null default 'confirmed'
  check (review_state in ('pending_review','confirmed'));
update public.agencies set review_state = 'pending_review' where unreviewed = true;
update public.branches set review_state = 'pending_review' where unreviewed = true;
alter table public.agencies drop column if exists unreviewed;
alter table public.branches drop column if exists unreviewed;

-- 2) Org audit (on-the-fly creations + confirmations).
create table if not exists public.org_audit (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,   -- agency | branch | contact
  entity_id uuid not null,
  action text not null,        -- created | confirmed
  detail text,
  actor text,
  actor_id uuid,
  at timestamptz not null default now()
);
create index if not exists org_audit_entity_idx on public.org_audit(entity_type, entity_id, at desc);
alter table public.org_audit enable row level security;
drop policy if exists org_audit_admin_read on public.org_audit;
create policy org_audit_admin_read on public.org_audit for select to authenticated using (public.is_admin());
drop policy if exists require_aal2 on public.org_audit;
create policy require_aal2 on public.org_audit as restrictive for all to authenticated using (public.is_aal2()) with check (public.is_aal2());

-- 3) Resolve-or-create the referral target on the fly. SECURITY DEFINER so a
--    referrer can also create the agency-default contact (RLS otherwise limits
--    contact writes to admin/management). Scoped to the caller's partner; new
--    entities are pending_review.
create or replace function public.create_referral_target(
  p_agency text, p_branch text,
  p_agency_email text default null, p_agency_contact_name text default null, p_agency_phone text default null,
  p_branch_email text default null, p_branch_contact_name text default null, p_branch_phone text default null
) returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare pid uuid; me uuid := auth.uid(); who text; ag_id uuid; br_id uuid;
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
    insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
    values ('agency', ag_id, 'created', btrim(p_agency), who, me);
  end if;

  select id into br_id from public.branches where agency_id = ag_id and lower(name) = lower(btrim(p_branch)) limit 1;
  if br_id is null then
    insert into public.branches(name, agency_id, partner_id, review_state, created_by)
    values (btrim(p_branch), ag_id, pid, 'pending_review', me) returning id into br_id;
    insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
    values ('branch', br_id, 'created', btrim(p_branch), who, me);
  end if;

  -- Agency-default contact: only when an email was given and the agency has none yet.
  if coalesce(btrim(p_agency_email),'') <> '' and not exists (select 1 from public.agent_contacts where agency_id = ag_id) then
    insert into public.agent_contacts(agency_id, partner_id, name, email, phone, is_primary, created_by)
    values (ag_id, pid, coalesce(nullif(btrim(p_agency_contact_name),''), btrim(p_agency_email)), btrim(p_agency_email), nullif(btrim(p_agency_phone),''), true, me);
  end if;

  -- Optional branch contact.
  if coalesce(btrim(p_branch_email),'') <> '' then
    insert into public.agent_contacts(branch_id, partner_id, name, email, phone, is_primary, created_by)
    values (br_id, pid, coalesce(nullif(btrim(p_branch_contact_name),''), btrim(p_branch_email)), btrim(p_branch_email), nullif(btrim(p_branch_phone),''), true, me);
  end if;

  return br_id;
end $function$;
revoke execute on function public.create_referral_target(text,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.create_referral_target(text,text,text,text,text,text,text,text) to authenticated;

-- 4) Reconciliation queue (admin only): pending agencies + branches with parent,
--    creator, created-at, attached referral count, and a same/similar-name hint.
create or replace function public.reconciliation_queue()
returns table (
  entity_id uuid, entity_type text, name text, parent text,
  created_by_name text, created_at timestamptz, referral_count bigint,
  match_name text, match_exact boolean
)
language sql security definer set search_path to '' stable
as $function$
  with pend as (
    select a.id, 'agency'::text as etype, a.name, null::text as parent, a.created_by, a.created_at, a.partner_id
    from public.agencies a where a.review_state = 'pending_review'
    union all
    select b.id, 'branch'::text as etype, b.name, pa.name as parent, b.created_by, b.created_at, b.partner_id
    from public.branches b join public.agencies pa on pa.id = b.agency_id where b.review_state = 'pending_review'
  )
  select
    p.id, p.etype, p.name, p.parent,
    coalesce(u.full_name, 'A referrer') as created_by_name,
    p.created_at,
    (select count(*) from public.applications ap
       where (p.etype = 'agency' and ap.agency_id = p.id) or (p.etype = 'branch' and ap.branch_id = p.id)) as referral_count,
    m.name as match_name,
    coalesce(m.exact, false) as match_exact
  from pend p
  left join public.users u on u.id = p.created_by
  left join lateral (
    select c.name, (lower(c.name) = lower(p.name)) as exact
    from (
      select a.name from public.agencies a where p.etype = 'agency' and a.review_state = 'confirmed' and a.partner_id = p.partner_id
      union all
      select b.name from public.branches b where p.etype = 'branch' and b.review_state = 'confirmed' and b.partner_id = p.partner_id
    ) c
    where lower(c.name) = lower(p.name)
       or lower(c.name) like '%' || lower(p.name) || '%'
       or lower(p.name) like '%' || lower(c.name) || '%'
    order by (lower(c.name) = lower(p.name)) desc
    limit 1
  ) m on true
  where public.is_aal2() and public.is_admin()
  order by p.created_at desc;
$function$;
revoke execute on function public.reconciliation_queue() from public, anon;
grant execute on function public.reconciliation_queue() to authenticated;

-- 5) Confirm a pending entity as a new canonical record (admin only), audited.
create or replace function public.confirm_org_entity(p_type text, p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare me uuid := auth.uid(); who text; nm text;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if not public.is_admin() then raise exception 'not permitted' using errcode = '42501'; end if;
  who := coalesce((select full_name from public.users where id = me), 'an administrator');
  if p_type = 'agency' then
    update public.agencies set review_state = 'confirmed' where id = p_id and review_state = 'pending_review' returning name into nm;
  elsif p_type = 'branch' then
    update public.branches set review_state = 'confirmed' where id = p_id and review_state = 'pending_review' returning name into nm;
  else
    raise exception 'Unknown entity type' using errcode = '22023';
  end if;
  if nm is null then raise exception 'Entity not found or already confirmed' using errcode = '22023'; end if;
  insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
  values (p_type, p_id, 'confirmed', nm, who, me);
end $function$;
revoke execute on function public.confirm_org_entity(text, uuid) from public, anon;
grant execute on function public.confirm_org_entity(text, uuid) to authenticated;
