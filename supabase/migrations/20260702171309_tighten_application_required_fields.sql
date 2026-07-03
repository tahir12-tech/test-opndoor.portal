-- ============================================================
-- Backfill seed rows so the new required-field rules hold retroactively.
-- ============================================================

-- Lighter/older rows carry only an outcode. Derive a full postcode from the
-- trailing token and clean it out of address line 1.
update public.applications set
  prop_postcode = trim(substring(prop_addr1 from '[^,]+$')) || ' 1AA',
  prop_addr1    = btrim(regexp_replace(prop_addr1, ',[[:space:]]*[A-Za-z0-9]+[[:space:]]*$', ''))
where prop_postcode is null;

-- Complete any remaining outcode-only postcodes to a full, valid format.
update public.applications set prop_postcode = prop_postcode || ' 1AA'
where prop_postcode !~* '^[a-z]{1,2}[0-9][a-z0-9]? ?[0-9][a-z]{2}$';

-- Fill the other newly-required fields (tenant PII was not seeded).
update public.applications set
  tenant_dob   = coalesce(tenant_dob, make_date(1980 + (abs(hashtext(guarantee_ref)) % 20),
                                                1 + (abs(hashtext(guarantee_ref)) % 12),
                                                1 + (abs(hashtext(guarantee_ref)) % 27))),
  tenant_phone = coalesce(nullif(btrim(tenant_phone), ''), '07700 900' || lpad((abs(hashtext(guarantee_ref)) % 1000)::text, 3, '0')),
  prop_city    = coalesce(nullif(btrim(prop_city), ''), 'London');

-- ============================================================
-- Constraints: required, non-empty, and format-validated fields.
-- ============================================================
alter table public.applications drop constraint applications_monthly_rent_check;
alter table public.applications add constraint applications_monthly_rent_check check (monthly_rent > 0);

alter table public.applications
  add constraint applications_title_valid   check (tenant_title in ('Mr','Mrs','Miss','Ms','Mx','Dr')),
  add constraint applications_first_present  check (btrim(tenant_first_name) <> ''),
  add constraint applications_last_present   check (btrim(tenant_last_name) <> ''),
  add constraint applications_email_valid    check (tenant_email ~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  add constraint applications_phone_present  check (btrim(tenant_phone) <> '' and tenant_phone ~ '[0-9]'),
  add constraint applications_addr1_present  check (btrim(prop_addr1) <> ''),
  add constraint applications_city_present   check (btrim(prop_city) <> ''),
  add constraint applications_postcode_valid check (prop_postcode ~* '^[a-z]{1,2}[0-9][a-z0-9]? ?[0-9][a-z]{2}$');

alter table public.applications
  alter column tenant_title  set not null,
  alter column tenant_dob    set not null,
  alter column tenant_email  set not null,
  alter column tenant_phone  set not null,
  alter column prop_city     set not null,
  alter column prop_postcode set not null;

-- ============================================================
-- create_referral: validate every required field and name what is missing.
-- ============================================================
create or replace function public.create_referral(
  p_branch uuid,
  p_tenant_title text, p_first text, p_last text, p_dob date, p_email text, p_phone text,
  p_addr1 text, p_addr2 text, p_city text, p_county text, p_postcode text,
  p_rent numeric, p_tenancy_start date
) returns public.applications
language plpgsql security definer set search_path = '' as $$
declare ag uuid; pid uuid; a public.applications; errs text[] := '{}';
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;

  if coalesce(p_tenant_title,'') not in ('Mr','Mrs','Miss','Ms','Mx','Dr') then errs := errs || 'title'; end if;
  if btrim(coalesce(p_first,'')) = '' then errs := errs || 'first name'; end if;
  if btrim(coalesce(p_last,'')) = '' then errs := errs || 'last name'; end if;
  if p_dob is null then errs := errs || 'date of birth';
  elsif p_dob >= current_date then errs := errs || 'date of birth (must be in the past)'; end if;
  if coalesce(p_email,'') !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then errs := errs || 'email'; end if;
  if btrim(coalesce(p_phone,'')) = '' or p_phone !~ '[0-9]' then errs := errs || 'phone'; end if;
  if btrim(coalesce(p_addr1,'')) = '' then errs := errs || 'address line 1'; end if;
  if btrim(coalesce(p_city,'')) = '' then errs := errs || 'city/town'; end if;
  if coalesce(p_postcode,'') !~* '^[a-z]{1,2}[0-9][a-z0-9]? ?[0-9][a-z]{2}$' then errs := errs || 'postcode'; end if;
  if p_rent is null or p_rent <= 0 then errs := errs || 'monthly rent'; end if;
  if p_tenancy_start is null then errs := errs || 'tenancy start date'; end if;
  if p_branch is null then errs := errs || 'branch'; end if;

  if array_length(errs, 1) > 0 then
    raise exception 'Missing or invalid: %', array_to_string(errs, ', ') using errcode = '22023';
  end if;

  select agency_id, partner_id into ag, pid from public.branches where id = p_branch;
  if ag is null then raise exception 'Selected branch not found' using errcode = '22023'; end if;
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
    p_tenant_title, btrim(p_first), btrim(p_last), p_dob, btrim(p_email), btrim(p_phone),
    btrim(p_addr1), nullif(btrim(coalesce(p_addr2,'')), ''), btrim(p_city),
    nullif(btrim(coalesce(p_county,'')), ''), upper(btrim(p_postcode)),
    p_rent, p_tenancy_start, 'sent', now()
  ) returning * into a;
  return a;
end $$;
