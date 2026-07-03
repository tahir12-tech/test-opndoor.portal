-- ============================================================
-- Access control: helper fns, RLS policies, lifecycle RPCs, views
-- ============================================================

-- ---------- who am I (SECURITY DEFINER: read the caller's profile, bypassing RLS to avoid recursion) ----------
create or replace function public.app_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.users where id = auth.uid()
$$;

create or replace function public.app_partner() returns uuid
language sql stable security definer set search_path = '' as $$
  select partner_id from public.users where id = auth.uid()
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select role = 'superadmin' from public.users where id = auth.uid()), false)
$$;

-- MFA gate: true only when the session has stepped up to AAL2 (password + verified code).
create or replace function public.is_aal2() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
$$;

-- ---------- effective contact (branch-first, agency-fallback) ----------
create or replace function public.effective_contacts(p_branch uuid)
returns setof public.agent_contacts
language sql stable security definer set search_path = '' as $$
  select * from public.agent_contacts where branch_id = p_branch
  union all
  select c.* from public.agent_contacts c
  where c.agency_id = (select agency_id from public.branches where id = p_branch)
    and not exists (select 1 from public.agent_contacts b where b.branch_id = p_branch)
$$;

create or replace function public.effective_primary_contact(p_branch uuid)
returns public.agent_contacts
language sql stable security definer set search_path = '' as $$
  select * from public.effective_contacts(p_branch) where is_primary limit 1
$$;

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.partners       enable row level security;
alter table public.users          enable row level security;
alter table public.agencies       enable row level security;
alter table public.branches       enable row level security;
alter table public.agent_contacts enable row level security;
alter table public.applications   enable row level security;

-- Restrictive MFA gate on every table: no data at all unless the session is AAL2.
create policy require_aal2 on public.partners       as restrictive for all to authenticated using (public.is_aal2()) with check (public.is_aal2());
create policy require_aal2 on public.users          as restrictive for all to authenticated using (public.is_aal2()) with check (public.is_aal2());
create policy require_aal2 on public.agencies       as restrictive for all to authenticated using (public.is_aal2()) with check (public.is_aal2());
create policy require_aal2 on public.branches       as restrictive for all to authenticated using (public.is_aal2()) with check (public.is_aal2());
create policy require_aal2 on public.agent_contacts as restrictive for all to authenticated using (public.is_aal2()) with check (public.is_aal2());
create policy require_aal2 on public.applications   as restrictive for all to authenticated using (public.is_aal2()) with check (public.is_aal2());

-- ---------- partners ----------
create policy partners_select on public.partners for select to authenticated
  using (public.is_admin() or id = public.app_partner());
create policy partners_admin_write on public.partners for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- users ----------
create policy users_select on public.users for select to authenticated using (
  public.is_admin()
  or (public.app_role() = 'management' and partner_id = public.app_partner())
  or id = auth.uid()
);
create policy users_admin_write on public.users for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy users_mgmt_insert on public.users for insert to authenticated with check (
  public.app_role() = 'management' and partner_id = public.app_partner() and role in ('management','referrer')
);
create policy users_mgmt_update on public.users for update to authenticated
  using  (public.app_role() = 'management' and partner_id = public.app_partner() and role in ('management','referrer'))
  with check (public.app_role() = 'management' and partner_id = public.app_partner() and role in ('management','referrer'));

-- ---------- agencies ----------
create policy agencies_select on public.agencies for select to authenticated
  using (public.is_admin() or partner_id = public.app_partner());
create policy agencies_insert on public.agencies for insert to authenticated
  with check (public.is_admin() or partner_id = public.app_partner());
create policy agencies_admin_update on public.agencies for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy agencies_admin_delete on public.agencies for delete to authenticated
  using (public.is_admin());

-- ---------- branches (partner_id is trigger-synced from the agency, then checked here) ----------
create policy branches_select on public.branches for select to authenticated
  using (public.is_admin() or partner_id = public.app_partner());
create policy branches_insert on public.branches for insert to authenticated
  with check (public.is_admin() or partner_id = public.app_partner());
create policy branches_admin_update on public.branches for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy branches_admin_delete on public.branches for delete to authenticated
  using (public.is_admin());

-- ---------- agent_contacts (referrers may read within their partner but never write) ----------
create policy contacts_select on public.agent_contacts for select to authenticated
  using (public.is_admin() or partner_id = public.app_partner());
create policy contacts_insert on public.agent_contacts for insert to authenticated
  with check (public.is_admin() or (public.app_role() = 'management' and partner_id = public.app_partner()));
create policy contacts_update on public.agent_contacts for update to authenticated
  using  (public.is_admin() or (public.app_role() = 'management' and partner_id = public.app_partner()))
  with check (public.is_admin() or (public.app_role() = 'management' and partner_id = public.app_partner()));
create policy contacts_delete on public.agent_contacts for delete to authenticated
  using (public.is_admin() or (public.app_role() = 'management' and partner_id = public.app_partner()));

-- ---------- applications ----------
create policy applications_select on public.applications for select to authenticated using (
  public.is_admin()
  or (public.app_role() = 'management' and partner_id = public.app_partner())
  or (public.app_role() = 'referrer'   and referrer_id = auth.uid())
);
create policy applications_insert on public.applications for insert to authenticated with check (
  public.is_admin()
  or (public.app_role() in ('management','referrer') and referrer_id = auth.uid() and partner_id = public.app_partner())
);
create policy applications_update on public.applications for update to authenticated
using (
  public.is_admin()
  or (public.app_role() = 'management' and partner_id = public.app_partner())
  or (public.app_role() = 'referrer'   and referrer_id = auth.uid() and status = 'sent')
)
with check (
  public.is_admin()
  or (public.app_role() = 'management' and partner_id = public.app_partner())
  or (public.app_role() = 'referrer'   and referrer_id = auth.uid() and status = 'sent')
);
create policy applications_delete on public.applications for delete to authenticated
  using (public.is_admin());

-- ============================================================
-- Lifecycle RPCs: encode the permission rules server-side.
-- Each self-guards AAL2 and re-checks role/scope, with RLS as the backstop.
-- ============================================================
create or replace function public.create_referral(
  p_branch uuid,
  p_tenant_title text, p_first text, p_last text, p_dob date, p_email text, p_phone text,
  p_addr1 text, p_addr2 text, p_city text, p_county text, p_postcode text,
  p_rent numeric, p_tenancy_start date
) returns public.applications
language plpgsql security definer set search_path = '' as $$
declare ag uuid; pid uuid; a public.applications;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select agency_id, partner_id into ag, pid from public.branches where id = p_branch;
  if ag is null then raise exception 'branch not found'; end if;
  if not (public.is_admin() or pid = public.app_partner()) then
    raise exception 'not permitted for this partner' using errcode = '42501';
  end if;
  insert into public.applications(
    guarantee_ref, branch_id, agency_id, partner_id, referrer_id,
    tenant_title, tenant_first_name, tenant_last_name, tenant_dob, tenant_email, tenant_phone,
    prop_addr1, prop_addr2, prop_city, prop_county, prop_postcode,
    monthly_rent, tenancy_start, status, sent_at
  ) values (
    'GR-' || nextval('public.guarantee_ref_seq')::text, p_branch, ag, pid, auth.uid(),
    p_tenant_title, p_first, p_last, p_dob, p_email, p_phone,
    p_addr1, p_addr2, p_city, p_county, p_postcode,
    p_rent, p_tenancy_start, 'sent', now()
  ) returning * into a;
  return a;
end $$;

create or replace function public.amend_tenancy_start(p_app uuid, p_new_start date)
returns public.applications
language plpgsql security definer set search_path = '' as $$
declare a public.applications; r text; owned boolean;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into a from public.applications where id = p_app;
  if not found then raise exception 'application not found'; end if;
  r := public.app_role();
  owned := a.referrer_id = auth.uid();
  if not (public.is_admin()
          or (r = 'management' and a.partner_id = public.app_partner())
          or (r = 'referrer'   and owned)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not public.can_amend_tenancy_start(r, a.status, owned) then
    raise exception 'amend not permitted for this role and status' using errcode = '42501';
  end if;
  update public.applications set
    tenancy_start  = p_new_start,
    issue_date     = case when status = 'deed' then now()::date else issue_date end,
    deed_issued_at = case when status = 'deed' then now()      else deed_issued_at end
  where id = p_app returning * into a;
  return a;   -- expiry_date recomputes automatically from the new tenancy_start
end $$;

create or replace function public.send_deed_to_agent(
  p_app uuid, p_recipient_email text default null, p_save_contact boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.applications; r text; owned boolean; eff public.agent_contacts; recipient text;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into a from public.applications where id = p_app;
  if not found then raise exception 'application not found'; end if;
  r := public.app_role();
  owned := a.referrer_id = auth.uid();
  if not (public.is_admin()
          or (r = 'management' and a.partner_id = public.app_partner())
          or (r = 'referrer'   and owned)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not public.can_send_deed(r, owned) then
    raise exception 'send not permitted for this role' using errcode = '42501';
  end if;
  if a.status <> 'deed' then raise exception 'deed not yet issued'; end if;
  -- referrers may only send to the resolved effective contact and cannot save contacts
  if r = 'referrer' and (p_recipient_email is not null or p_save_contact) then
    raise exception 'referrers may only send to the resolved contact and cannot save contacts' using errcode = '42501';
  end if;
  select * into eff from public.effective_primary_contact(a.branch_id);
  recipient := coalesce(p_recipient_email, eff.email);
  -- INTEGRATION: email delivery + activity logging land with the email/notifications integration.
  return jsonb_build_object('sent_to', recipient, 'resolved_contact', eff.email, 'resolved_name', eff.name);
end $$;

create or replace function public.set_application_status(p_app uuid, p_status text)
returns public.applications
language plpgsql security definer set search_path = '' as $$
declare a public.applications;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if p_status not in ('sent','paid','deed') then raise exception 'invalid status'; end if;
  select * into a from public.applications where id = p_app;
  if not found then raise exception 'application not found'; end if;
  -- transitions represent Stripe/PandaDoc events in production; here, admin or management-in-partner.
  if not (public.is_admin() or (public.app_role() = 'management' and a.partner_id = public.app_partner())) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  update public.applications set
    status         = p_status,
    paid_at        = case when p_status in ('paid','deed') then coalesce(paid_at, now())      else paid_at end,
    deed_issued_at = case when p_status = 'deed'           then coalesce(deed_issued_at, now()) else deed_issued_at end,
    issue_date     = case when p_status = 'deed'           then coalesce(issue_date, now()::date) else issue_date end
  where id = p_app returning * into a;
  return a;
end $$;

-- ============================================================
-- Read-model views (security_invoker: inherit the caller's RLS on applications)
-- ============================================================
create view public.activity_feed with (security_invoker = on) as
  select a.id::text || ':sent' as id, 'sent'::text as kind, a.guarantee_ref as ref,
         (a.tenant_first_name || ' ' || a.tenant_last_name) as tenant,
         a.prop_addr1 as prop, b.name as branch, ag.name as agency,
         a.partner_id, a.referrer_id, a.sent_at as at
  from public.applications a
  join public.branches b  on b.id = a.branch_id
  join public.agencies ag on ag.id = a.agency_id
  union all
  select a.id::text || ':paid', 'paid', a.guarantee_ref,
         (a.tenant_first_name || ' ' || a.tenant_last_name),
         a.prop_addr1, b.name, ag.name, a.partner_id, a.referrer_id, a.paid_at
  from public.applications a
  join public.branches b  on b.id = a.branch_id
  join public.agencies ag on ag.id = a.agency_id
  where a.paid_at is not null
  union all
  select a.id::text || ':deed', 'deed', a.guarantee_ref,
         (a.tenant_first_name || ' ' || a.tenant_last_name),
         a.prop_addr1, b.name, ag.name, a.partner_id, a.referrer_id, a.deed_issued_at
  from public.applications a
  join public.branches b  on b.id = a.branch_id
  join public.agencies ag on ag.id = a.agency_id
  where a.deed_issued_at is not null;

create view public.upcoming_expiries with (security_invoker = on) as
  select a.id, a.guarantee_ref as ref,
         (a.tenant_first_name || ' ' || a.tenant_last_name) as tenant,
         a.prop_addr1 as prop, b.name as branch, ag.name as agency,
         a.partner_id, a.referrer_id, a.expiry_date as expiry,
         (a.expiry_date - current_date) as days_until
  from public.applications a
  join public.branches b  on b.id = a.branch_id
  join public.agencies ag on ag.id = a.agency_id
  where a.status = 'deed';

grant select on public.activity_feed    to authenticated;
grant select on public.upcoming_expiries to authenticated;
