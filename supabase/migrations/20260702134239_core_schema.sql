-- ============================================================
-- opndoor Guarantee Referral Portal - core schema
-- ============================================================

-- Guarantee expiry: single source of truth.
-- Replicates the app's guaranteeExpiry(): new Date(y+1, m, d-1),
-- i.e. first-of-(month, next year) + (day - 2) days. This matches JS
-- Date normalisation exactly, including the Feb-29 leap-start edge.
create or replace function public.guarantee_expiry(tenancy_start date)
returns date language sql immutable as $$
  select (make_date(
            (extract(year  from tenancy_start))::int + 1,
            (extract(month from tenancy_start))::int,
            1) + ((extract(day from tenancy_start))::int - 2))::date
$$;
comment on function public.guarantee_expiry(date) is
  'Guarantee expiry = tenancy start + 12 months - 1 day. Single source of truth, matches the app''s guaranteeExpiry().';

-- Permission rules, mirroring canAmendTenancyStart / canSendDeed.
create or replace function public.can_amend_tenancy_start(p_role text, p_status text, p_owned boolean)
returns boolean language sql immutable as $$
  select case
    when p_status = 'sent' then (case when p_role = 'referrer' then p_owned else true end)
    else p_role in ('superadmin','management')
  end
$$;

create or replace function public.can_send_deed(p_role text, p_owned boolean)
returns boolean language sql immutable as $$
  select case when p_role = 'referrer' then p_owned else p_role in ('superadmin','management') end
$$;

-- Reference numbers for new referrals (seed uses explicit refs below this).
create sequence if not exists public.guarantee_ref_seq as bigint start with 20601 increment by 1;

-- ---------- tables ----------
create table public.partners (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  status text not null default 'active' check (status in ('active','onboarding','paused')),
  live_from date,
  partner_rate numeric(5,4) not null default 0.25 check (partner_rate >= 0 and partner_rate <= 1),
  agent_rate numeric(5,4) not null default 0.10 check (agent_rate >= 0 and agent_rate <= 1),
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  role text not null check (role in ('superadmin','management','referrer')),
  partner_id uuid references public.partners(id) on delete restrict,
  status text not null default 'active' check (status in ('active','pending')),
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  constraint users_partner_by_role check (
    (role = 'superadmin' and partner_id is null) or
    (role <> 'superadmin' and partner_id is not null)
  )
);

create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  name text not null,
  group_name text,
  unreviewed boolean not null default false,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (partner_id, name)
);

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  partner_id uuid not null references public.partners(id) on delete cascade,
  name text not null,
  area text,
  unreviewed boolean not null default false,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (agency_id, name)
);

create table public.agent_contacts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references public.agencies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  partner_id uuid not null references public.partners(id) on delete cascade,
  name text not null,
  email text not null,
  phone text,
  contact_role text,
  is_primary boolean not null default false,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint agent_contacts_one_owner check ((agency_id is not null) <> (branch_id is not null))
);
create unique index agent_contacts_primary_per_agency on public.agent_contacts (agency_id) where is_primary and agency_id is not null;
create unique index agent_contacts_primary_per_branch on public.agent_contacts (branch_id) where is_primary and branch_id is not null;
create index agent_contacts_agency_idx  on public.agent_contacts (agency_id);
create index agent_contacts_branch_idx  on public.agent_contacts (branch_id);
create index agent_contacts_partner_idx on public.agent_contacts (partner_id);

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  guarantee_ref text unique not null,
  partner_id uuid not null references public.partners(id) on delete cascade,
  agency_id uuid not null references public.agencies(id),
  branch_id uuid not null references public.branches(id),
  referrer_id uuid not null references public.users(id),
  tenant_title text,
  tenant_first_name text not null,
  tenant_last_name text not null,
  tenant_dob date,
  tenant_email text,
  tenant_phone text,
  prop_addr1 text not null,
  prop_addr2 text,
  prop_city text,
  prop_county text,
  prop_postcode text,
  monthly_rent numeric(10,2) not null check (monthly_rent >= 0),
  tenancy_start date not null,
  status text not null default 'sent' check (status in ('sent','paid','deed')),
  sent_at timestamptz not null default now(),
  paid_at timestamptz,
  deed_issued_at timestamptz,
  issue_date date,
  expiry_date date generated always as (public.guarantee_expiry(tenancy_start)) stored,
  created_at timestamptz not null default now(),
  constraint applications_status_dates check (
    status = 'sent'
    or (status = 'paid' and paid_at is not null)
    or (status = 'deed' and paid_at is not null and deed_issued_at is not null)
  )
);
create index applications_partner_idx  on public.applications (partner_id);
create index applications_referrer_idx on public.applications (referrer_id);
create index applications_branch_idx   on public.applications (branch_id);
create index applications_agency_idx   on public.applications (agency_id);
create index applications_status_idx   on public.applications (status);
create index applications_expiry_idx   on public.applications (expiry_date);

-- ---------- triggers: keep denormalised partner_id (and app agency_id) consistent ----------
create or replace function public.sync_branch_partner() returns trigger
language plpgsql as $$
begin
  select partner_id into new.partner_id from public.agencies where id = new.agency_id;
  if new.partner_id is null then raise exception 'agency % not found', new.agency_id; end if;
  return new;
end $$;
create trigger branches_sync_partner before insert or update of agency_id on public.branches
  for each row execute function public.sync_branch_partner();

create or replace function public.sync_contact_partner() returns trigger
language plpgsql as $$
begin
  if new.agency_id is not null then
    select partner_id into new.partner_id from public.agencies where id = new.agency_id;
  else
    select partner_id into new.partner_id from public.branches where id = new.branch_id;
  end if;
  if new.partner_id is null then raise exception 'contact owner not found'; end if;
  return new;
end $$;
create trigger contacts_sync_partner before insert or update of agency_id, branch_id on public.agent_contacts
  for each row execute function public.sync_contact_partner();

create or replace function public.sync_application_partner() returns trigger
language plpgsql as $$
declare b record;
begin
  select agency_id, partner_id into b from public.branches where id = new.branch_id;
  if not found then raise exception 'branch % not found', new.branch_id; end if;
  new.agency_id := b.agency_id;
  new.partner_id := b.partner_id;
  return new;
end $$;
create trigger applications_sync_partner before insert or update of branch_id on public.applications
  for each row execute function public.sync_application_partner();

-- ---------- trigger: exactly one primary contact per owner ----------
create or replace function public.contacts_maintain_primary() returns trigger
language plpgsql as $$
declare cnt int;
begin
  if tg_op = 'INSERT' then
    if new.agency_id is not null then
      select count(*) into cnt from public.agent_contacts where agency_id = new.agency_id;
    else
      select count(*) into cnt from public.agent_contacts where branch_id = new.branch_id;
    end if;
    if cnt = 0 then new.is_primary := true; end if;  -- first contact for an owner is primary
  end if;

  if new.is_primary then  -- unset the previous primary before this row claims it
    if new.agency_id is not null then
      update public.agent_contacts set is_primary = false
        where agency_id = new.agency_id and is_primary and id <> new.id;
    else
      update public.agent_contacts set is_primary = false
        where branch_id = new.branch_id and is_primary and id <> new.id;
    end if;
  end if;
  return new;
end $$;
create trigger agent_contacts_maintain_primary before insert or update on public.agent_contacts
  for each row execute function public.contacts_maintain_primary();

create or replace function public.contacts_promote_on_delete() returns trigger
language plpgsql as $$
declare nxt uuid;
begin
  if old.is_primary then
    if old.agency_id is not null then
      select id into nxt from public.agent_contacts where agency_id = old.agency_id order by created_at, id limit 1;
    else
      select id into nxt from public.agent_contacts where branch_id = old.branch_id order by created_at, id limit 1;
    end if;
    if nxt is not null then update public.agent_contacts set is_primary = true where id = nxt; end if;
  end if;
  return null;
end $$;
create trigger agent_contacts_promote_on_delete after delete on public.agent_contacts
  for each row execute function public.contacts_promote_on_delete();
