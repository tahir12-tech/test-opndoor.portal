-- #97 Snapshot the referrer's display name onto the application at creation, so
-- attribution survives the user's lifecycle (deactivation, or the referrer being
-- hidden from a viewer by users-RLS, which made the dashboard show "(unknown)" with
-- fees attached). Analytics read this snapshot, not a live join. Backfill existing
-- rows from users where resolvable.
alter table public.applications add column if not exists referrer_name text;

update public.applications a
  set referrer_name = u.full_name
  from public.users u
  where u.id = a.referrer_id and a.referrer_name is null and u.full_name is not null;

-- create_referral now stamps referrer_name from the creating user (referrer_id =
-- auth.uid()), so a new record can never be orphaned to "(unknown)".
create or replace function public.create_referral(p_branch uuid, p_tenant_title text, p_first text, p_last text, p_dob date, p_email text, p_phone text, p_addr1 text, p_addr2 text, p_city text, p_county text, p_postcode text, p_rent numeric, p_tenancy_start date)
 returns applications
 language plpgsql security definer set search_path to ''
as $function$
declare ag uuid; pid uuid; prate numeric; arate numeric; a public.applications; errs text[] := '{}';
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;

  if coalesce(p_tenant_title,'') not in ('Mr','Mrs','Miss','Ms','Mx','Dr') then errs := array_append(errs, 'title'); end if;
  if btrim(coalesce(p_first,'')) = '' then errs := array_append(errs, 'first name'); end if;
  if btrim(coalesce(p_last,'')) = '' then errs := array_append(errs, 'last name'); end if;
  if p_dob is null then errs := array_append(errs, 'date of birth');
  elsif p_dob >= current_date then errs := array_append(errs, 'date of birth (must be in the past)'); end if;
  if coalesce(p_email,'') !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then errs := array_append(errs, 'email'); end if;
  if btrim(coalesce(p_phone,'')) = '' or p_phone !~ '[0-9]' then errs := array_append(errs, 'phone'); end if;
  if btrim(coalesce(p_addr1,'')) = '' then errs := array_append(errs, 'address line 1'); end if;
  if btrim(coalesce(p_city,'')) = '' then errs := array_append(errs, 'city/town'); end if;
  if coalesce(p_postcode,'') !~* '^[a-z]{1,2}[0-9][a-z0-9]? ?[0-9][a-z]{2}$' then errs := array_append(errs, 'postcode'); end if;
  if p_rent is null or p_rent <= 0 then errs := array_append(errs, 'monthly rent'); end if;
  if p_tenancy_start is null then errs := array_append(errs, 'tenancy start date'); end if;
  if p_branch is null then errs := array_append(errs, 'branch'); end if;

  if array_length(errs, 1) > 0 then
    raise exception 'Missing or invalid: %', array_to_string(errs, ', ') using errcode = '22023';
  end if;

  if (p_dob + interval '18 years')::date > p_tenancy_start then
    raise exception 'Tenant must be 18 by the tenancy start date.' using errcode = '22023';
  end if;
  if (p_dob + interval '100 years')::date < p_tenancy_start then
    raise exception 'Check the date of birth: the tenant would be over 100 at the tenancy start.' using errcode = '22023';
  end if;
  if p_tenancy_start < (current_date - interval '7 days')::date then
    raise exception 'Tenancy start date cannot be more than 7 days in the past.' using errcode = '22023';
  end if;
  if p_tenancy_start > (current_date + interval '2 years')::date then
    raise exception 'Tenancy start date cannot be more than 2 years ahead.' using errcode = '22023';
  end if;

  select b.agency_id, b.partner_id, p.partner_rate, p.agent_rate
    into ag, pid, prate, arate
  from public.branches b
  join public.partners p on p.id = b.partner_id
  where b.id = p_branch;
  if ag is null then raise exception 'Selected branch not found' using errcode = '22023'; end if;
  if not (public.is_admin() or pid = public.app_partner()) then
    raise exception 'not permitted for this partner' using errcode = '42501';
  end if;

  insert into public.applications(
    guarantee_ref, branch_id, agency_id, partner_id, referrer_id, referrer_name,
    tenant_title, tenant_first_name, tenant_last_name, tenant_dob, tenant_email, tenant_phone,
    prop_addr1, prop_addr2, prop_city, prop_county, prop_postcode,
    monthly_rent, tenancy_start, status, sent_at, partner_rate, agent_rate
  ) values (
    'GR-' || nextval('public.guarantee_ref_seq')::text, p_branch, ag, pid, auth.uid(),
    (select full_name from public.users where id = auth.uid()),
    p_tenant_title, btrim(p_first), btrim(p_last), p_dob, btrim(p_email), btrim(p_phone),
    btrim(p_addr1), nullif(btrim(coalesce(p_addr2,'')), ''), btrim(p_city),
    nullif(btrim(coalesce(p_county,'')), ''), upper(btrim(p_postcode)),
    p_rent, p_tenancy_start, 'sent', now(), prate, arate
  ) returning * into a;
  return a;
end $function$;