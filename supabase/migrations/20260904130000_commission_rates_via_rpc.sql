-- =====================================================================
-- Commission rates: governed READ PATH moves from views to RPCs
--
-- 20260904120000 exposed the confidential rates through two owner-rights views
-- (partner_commission_rates / application_commission_rates). They worked, but the
-- Supabase Security Advisor flags every such view as `security_definer_view`
-- (0010), and its only suggested remedy — `security_invoker = on` — cannot apply
-- here: the invoker is precisely who holds no privilege on the rate columns
-- (20260904120500). So the same gate moves into two SECURITY DEFINER functions
-- and the views are dropped. The advisor finding goes away; the privileged read
-- lands in the definer-function category this project already audits (Part D of
-- SECURITY-PROOF.md), where each function self-checks AAL2 + role + scope.
--
-- Rule, unchanged: opndoor admin reads every partner's rates, a partner's own
-- Management reads theirs, a Referrer reads none.
--
-- They RETURN NO ROWS for a caller who is not entitled, and never raise. That
-- matters: the client loads these alongside its other datasets and treats any
-- error as a failed sign-in, so a Referrer must get an empty set, not a 42501.
-- Absent rates then read as "withheld" throughout the front end.
--
-- Deploy note: dropping the views only affects a client that reads them, and the
-- only such client is the one being deployed with this change, so there is no
-- ordering hazard against the currently deployed build (which reads neither).
-- =====================================================================

-- ---------- The two governed readers ----------
-- Owner's rights are what let these read a column `authenticated` cannot; the
-- WHERE clause is the whole gate, and it re-asserts AAL2 because a definer
-- function bypasses the restrictive require_aal2 policy on the base tables.
-- Every column reference is alias-qualified so it can never collide with the
-- RETURNS TABLE output names.
create or replace function public.commission_rates_for_partners()
returns table (partner_id uuid, slug text, partner_rate numeric, agent_rate numeric)
language sql
stable
security definer
set search_path = ''
as $function$
  select p.id, p.slug, p.partner_rate, p.agent_rate
  from public.partners p
  where public.is_aal2()
    and (public.is_admin()
         or (public.app_role() = 'management' and p.id = public.app_partner()));
$function$;

create or replace function public.commission_rates_for_applications()
returns table (application_id uuid, guarantee_ref text, partner_id uuid, partner_rate numeric, agent_rate numeric)
language sql
stable
security definer
set search_path = ''
as $function$
  select a.id, a.guarantee_ref, a.partner_id, a.partner_rate, a.agent_rate
  from public.applications a
  where public.is_aal2()
    and (public.is_admin()
         or (public.app_role() = 'management' and a.partner_id = public.app_partner()));
$function$;

comment on function public.commission_rates_for_partners() is
  'Live per-partner commission rates: every partner for opndoor admin, own partner for Management, no rows for a Referrer. AAL2 required.';
comment on function public.commission_rates_for_applications() is
  'Snapshotted per-application commission rates: all for opndoor admin, own partner for Management, no rows for a Referrer. AAL2 required.';

-- Signed-in sessions only; never anon, never PUBLIC (the repo's standing
-- revoke_anon_function_execute convention).
revoke execute on function public.commission_rates_for_partners() from public, anon;
revoke execute on function public.commission_rates_for_applications() from public, anon;
grant execute on function public.commission_rates_for_partners() to authenticated;
grant execute on function public.commission_rates_for_applications() to authenticated;

-- ---------- Retire the views ----------
-- Superseded by the functions above; their definitions remain in
-- 20260904120000_commission_rate_confidentiality.sql if this ever has to be undone.
drop view if exists public.partner_commission_rates;
drop view if exists public.application_commission_rates;
