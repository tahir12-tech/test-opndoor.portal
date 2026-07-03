-- ---------- amend_tenancy_start: require a sane, non-null new start date ----------
create or replace function public.amend_tenancy_start(p_app uuid, p_new_start date)
returns public.applications
language plpgsql security definer set search_path = '' as $$
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
  if not public.can_amend_tenancy_start(r, a.status, owned) then
    raise exception 'amend not permitted for this role and status' using errcode = '42501';
  end if;
  update public.applications set
    tenancy_start  = p_new_start,
    issue_date     = case when status = 'deed' then now()::date else issue_date end,
    deed_issued_at = case when status = 'deed' then now()      else deed_issued_at end
  where id = p_app returning * into a;
  return a;
end $$;

-- ---------- send_deed_to_agent: validate a provided recipient email ----------
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
  if r = 'referrer' and (p_recipient_email is not null or p_save_contact) then
    raise exception 'referrers may only send to the resolved contact and cannot save contacts' using errcode = '42501';
  end if;
  if p_recipient_email is not null and p_recipient_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'Invalid recipient email' using errcode = '22023';
  end if;
  select * into eff from public.effective_primary_contact(a.branch_id);
  recipient := coalesce(p_recipient_email, eff.email);
  return jsonb_build_object('sent_to', recipient, 'resolved_contact', eff.email, 'resolved_name', eff.name);
end $$;

-- ---------- non-empty / format constraints on the related tables ----------
alter table public.agencies       add constraint agencies_name_present   check (btrim(name) <> '');
alter table public.branches        add constraint branches_name_present   check (btrim(name) <> '');
alter table public.agent_contacts
  add constraint agent_contacts_name_present  check (btrim(name) <> ''),
  add constraint agent_contacts_email_valid   check (email ~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$');
alter table public.partners
  add constraint partners_name_present check (btrim(name) <> ''),
  add constraint partners_slug_valid  check (slug ~ '^[a-z0-9-]+$');
alter table public.users
  add constraint users_name_present  check (btrim(full_name) <> ''),
  add constraint users_email_valid   check (email ~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$');
