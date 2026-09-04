-- =====================================================================
-- Commission-rate confidentiality (partner_rate / agent_rate) — PART 1 of 2
--
-- ROLLOUT. This half is ADDITIVE and safe to apply to a live service on its own:
-- it creates the governed read path and masks the RPC return values, and takes
-- nothing away. The column privileges are dropped by PART 2
-- (20260904120500_revoke_commission_rate_columns.sql), which must NOT be applied
-- until a front end that reads the two views below is deployed — the previous
-- client selects partners.partner_rate / applications.partner_rate directly and
-- would fail its whole data load (nobody could sign in). Order:
--   1. this migration        2. deploy the front end        3. PART 2
--
-- THE HOLE. Both rate columns were readable by ANY partner staff member at
-- AAL2:
--   * partners_select      allows `id = public.app_partner()`  -> a Referrer
--     could read their own partner's row, rates included.
--   * applications_select  allows `referrer_id = auth.uid()`   -> a Referrer
--     could read the snapshotted rates on every application they created.
-- Both are ROW-level rules and RLS cannot hide a COLUMN, so a Referrer holding
-- nothing but their own JWT could ask PostgREST for
-- `/rest/v1/partners?select=partner_rate,agent_rate` and read exactly what
-- opndoor pays their partner. No screen renders it (#79 and #109 keep
-- commission off every referrer surface) - but the client is not the boundary.
--
-- THE FIX, in three parts:
--   1. COLUMN PRIVILEGES (defined here, APPLIED BY PART 2). `anon`/`authenticated`
--      lose SELECT/INSERT/UPDATE on partners.partner_rate, partners.agent_rate,
--      applications.partner_rate and applications.agent_rate. A column privilege
--      cannot be revoked while the role holds the table-wide one, so the table
--      grant is dropped and re-granted column by column for every OTHER column -
--      see public.reapply_rate_column_privileges() below, which PART 2 calls.
--   2. A GOVERNED READ PATH. Two owner-rights views re-expose the rates to the
--      roles entitled to them: opndoor admin (every partner) and a partner's
--      own Management (their partner only). A Referrer gets zero rows. The
--      views run with the OWNER's rights - that is how they read a column the
--      caller cannot - which also bypasses the base table's RLS, so each view
--      re-asserts the AAL2 gate and the partner scope in its own WHERE. They
--      are security_barrier, so no caller-supplied predicate can be pushed
--      below that gate.
--   3. RPC RETURN VALUES. Column privileges do not filter a function's return
--      value, so the three referrer-callable SECURITY DEFINER functions that
--      return a whole `applications` row (create_referral, amend_tenancy_start,
--      mark_withdrawn) now null the two rate fields for a caller who is not
--      entitled to them. Bodies are otherwise unchanged.
--
-- WRITES are unchanged: every rate write already goes through
-- update_partner_settings (admin) or create_referral (the snapshot), both
-- SECURITY DEFINER and both running as the owner. Dropping the two columns from
-- the client's INSERT/UPDATE grant additionally means a Referrer can no longer
-- hand-write a rate onto their own Sent application (applications_update allows
-- that row), so the rate-snapshot law is now enforced by privilege rather than
-- by convention.
--
-- MAINTENANCE NOTE. `anon`/`authenticated` now hold PER-COLUMN grants on
-- partners and applications, so a column added to either table by a LATER
-- migration is invisible to the app until the grants are re-applied. Any
-- migration that adds a column to those two tables must end with:
--     select public.reapply_rate_column_privileges();
-- =====================================================================

-- ---------- 1. Column privileges (the helper; PART 2 calls it) ----------
-- Re-applies the invariant "authenticated/anon may touch every column of
-- partners and applications EXCEPT the two commission rates". Idempotent, and
-- the one thing to re-run after adding a column to either table. Generated
-- columns (applications.expiry_date) can never be written, so they are granted
-- for SELECT only. Defining it changes no privilege; PART 2 invokes it.
create or replace function public.reapply_rate_column_privileges()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  t text;
  read_cols text;
  write_cols text;
begin
  foreach t in array array['partners', 'applications'] loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
           string_agg(quote_ident(a.attname), ', ' order by a.attnum) filter (where a.attgenerated = '')
      into read_cols, write_cols
    from pg_catalog.pg_attribute a
    where a.attrelid = ('public.' || quote_ident(t))::regclass
      and a.attnum > 0
      and not a.attisdropped
      and a.attname not in ('partner_rate', 'agent_rate');

    -- The table-wide grant has to go first: PostgreSQL ignores a column-level
    -- REVOKE while the role still holds the privilege on the whole table.
    execute format('revoke select, insert, update on public.%I from anon, authenticated', t);
    execute format('grant select (%s) on public.%I to anon, authenticated', read_cols, t);
    execute format('grant insert (%s), update (%s) on public.%I to anon, authenticated', write_cols, write_cols, t);
  end loop;
end
$function$;

comment on function public.reapply_rate_column_privileges() is
  'Re-grants every column of partners/applications to anon+authenticated EXCEPT partner_rate/agent_rate. Run after adding a column to either table.';

-- Maintenance only: nothing the app roles may call.
revoke all on function public.reapply_rate_column_privileges() from public, anon, authenticated;

-- NOT called here: see PART 2 (20260904120500_revoke_commission_rate_columns.sql).

-- ---------- 2. Governed read path ----------
-- Owner-rights views (deliberately NOT security_invoker: they must read a
-- column the caller cannot). That bypasses RLS on the base tables, so the WHERE
-- clause here IS the whole gate, and it repeats the AAL2 requirement that the
-- restrictive require_aal2 policy would otherwise apply.
drop view if exists public.partner_commission_rates;
create view public.partner_commission_rates with (security_barrier = true) as
  select p.id as partner_id, p.slug, p.partner_rate, p.agent_rate
  from public.partners p
  where public.is_aal2()
    and (public.is_admin()
         or (public.app_role() = 'management' and p.id = public.app_partner()));

drop view if exists public.application_commission_rates;
create view public.application_commission_rates with (security_barrier = true) as
  select a.id as application_id, a.guarantee_ref, a.partner_id, a.partner_rate, a.agent_rate
  from public.applications a
  where public.is_aal2()
    and (public.is_admin()
         or (public.app_role() = 'management' and a.partner_id = public.app_partner()));

comment on view public.partner_commission_rates is
  'Live per-partner commission rates. opndoor admin sees every partner, Management only its own, a Referrer none. AAL2 required.';
comment on view public.application_commission_rates is
  'Snapshotted per-application commission rates. opndoor admin sees every partner, Management only its own, a Referrer none. AAL2 required.';

grant select on public.partner_commission_rates     to authenticated;
grant select on public.application_commission_rates to authenticated;

-- ---------- 3. Rate masking on RPC return values ----------
-- A SECURITY DEFINER function's return value is not filtered by column
-- privileges, so an RPC handing back a whole applications row would post the
-- snapshot straight back to a Referrer. Blank the two fields unless the caller
-- is entitled to them (the same rule as application_commission_rates; the AAL2
-- gate is already asserted by every caller below).
create or replace function public.mask_commission_rates(a public.applications)
returns public.applications
language plpgsql
stable
set search_path = ''
as $function$
begin
  if public.is_admin()
     or (public.app_role() = 'management' and a.partner_id = public.app_partner()) then
    return a;
  end if;
  a.partner_rate := null;
  a.agent_rate   := null;
  return a;
end
$function$;

comment on function public.mask_commission_rates(public.applications) is
  'Nulls partner_rate/agent_rate on a returned applications row for a caller not entitled to commission rates (i.e. a Referrer).';

revoke all on function public.mask_commission_rates(public.applications) from public, anon, authenticated;

-- create_referral: unchanged from 20260705140347 (referrer_name snapshot) except
-- that the row it returns is rate-masked. The INSERT still snapshots the
-- partner's live rates onto the application (rate-snapshot law); it is only the
-- copy handed back to the caller that withholds them.
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
  return public.mask_commission_rates(a);
end $function$;

-- amend_tenancy_start: unchanged from 20260703103841 (deed-state-aware boundary)
-- except for the rate-masked return.
create or replace function public.amend_tenancy_start(p_app uuid, p_new_start date)
  returns public.applications
  language plpgsql
  security definer
  set search_path to ''
as $function$
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
  if not public.can_amend_tenancy_start(r, a.status, owned, a.deed_state) then
    raise exception 'amend not permitted for this role and status' using errcode = '42501';
  end if;
  -- Date only. expiry_date is generated from tenancy_start; the deed lifecycle is
  -- handled by the amend-tenancy-start Edge Function, not here.
  update public.applications set tenancy_start = p_new_start where id = p_app returning * into a;
  return public.mask_commission_rates(a);
end $function$;

-- mark_withdrawn: unchanged from 20260705095955 (by guarantee_ref) except for
-- the rate-masked return.
create or replace function public.mark_withdrawn(p_ref text, p_reason text, p_note text)
returns public.applications
language plpgsql security definer set search_path to ''
as $function$
declare a public.applications; r text; owned boolean; who text; lbl text;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into a from public.applications where guarantee_ref = p_ref;
  if not found then raise exception 'application not found'; end if;
  r := public.app_role();
  owned := a.referrer_id = auth.uid();
  if not (public.is_admin() or (r = 'management' and a.partner_id = public.app_partner()) or (r = 'referrer' and owned)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if a.status <> 'sent' then raise exception 'Only an application at Sent (before payment) can be withdrawn.' using errcode = '42501'; end if;
  if p_reason not in ('another_guarantor','tenancy_fell_through','duplicate','other') then
    raise exception 'Invalid withdrawal reason' using errcode = '22023';
  end if;
  if p_reason = 'other' and coalesce(btrim(p_note), '') = '' then
    raise exception 'A note is required when the reason is Other.' using errcode = '22023';
  end if;
  update public.applications
    set status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = p_reason,
        withdrawn_note = nullif(btrim(coalesce(p_note,'')), ''), withdrawn_by = auth.uid()
    where id = a.id returning * into a;
  who := coalesce((select full_name from public.users where id = auth.uid()), 'a user');
  lbl := case p_reason
           when 'another_guarantor' then 'tenant found another guarantor'
           when 'tenancy_fell_through' then 'tenancy fell through'
           when 'duplicate' then 'duplicate referral'
           else 'other' end;
  insert into public.activity_log(application_id, kind, message, actor, visibility)
  values (a.id, 'withdrawn',
    'Application withdrawn (' || lbl || ')' || case when a.withdrawn_note is not null then ': ' || a.withdrawn_note else '' end || '.',
    who, 'business');
  return public.mask_commission_rates(a);
end $function$;

-- Execute grants restated (create or replace preserves them; stated for the
-- same reason every other migration in this repo restates them).
revoke execute on function public.create_referral(uuid, text, text, text, date, text, text, text, text, text, text, text, numeric, date) from public, anon;
grant execute on function public.create_referral(uuid, text, text, text, date, text, text, text, text, text, text, text, numeric, date) to authenticated;
revoke execute on function public.amend_tenancy_start(uuid, date) from public, anon;
grant execute on function public.amend_tenancy_start(uuid, date) to authenticated, service_role;
revoke execute on function public.mark_withdrawn(text, text, text) from public, anon;
grant execute on function public.mark_withdrawn(text, text, text) to authenticated, service_role;
