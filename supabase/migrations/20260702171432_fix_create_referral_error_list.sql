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
