-- #81 Agent-reported tenancy-start corrections. The deed-delivery email carries a
-- tokenised link to a public single-application page where the agent can propose a
-- corrected tenancy start. Submitting NEVER writes the application: it records a
-- needs-attention item here + an activity_log entry; an opndoor admin reviews and
-- applies the change via the existing audited amend flow.
--
-- One row per issued link: created (with a random token, expiring like the 7-day
-- download link) when the deed is delivered; filled in when the agent submits.
create table if not exists public.tenancy_correction_tokens (
  token uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  guarantee_ref text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  proposed_start date,
  note text,
  submitted_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid
);
create index if not exists tenancy_correction_app_idx on public.tenancy_correction_tokens(application_id);

alter table public.tenancy_correction_tokens enable row level security;

-- opndoor admins, and the owning partner's Management, may read reports (to review
-- them). Writes happen exclusively through the service-role Edge Function (public
-- token exchange) and the amend flow, so there is deliberately no client
-- INSERT/UPDATE/DELETE policy.
drop policy if exists tct_read on public.tenancy_correction_tokens;
create policy tct_read on public.tenancy_correction_tokens
  for select to authenticated using (
    public.is_admin() or exists (
      select 1 from public.applications a
      where a.id = application_id and public.app_role() = 'management' and a.partner_id = public.app_partner()
    )
  );

-- Same app-wide MFA invariant as every other table.
drop policy if exists require_aal2 on public.tenancy_correction_tokens;
create policy require_aal2 on public.tenancy_correction_tokens
  as restrictive for all to authenticated
  using (public.is_aal2()) with check (public.is_aal2());

-- Dashboard needs-attention count: submitted-and-unresolved reports in the
-- caller's scope (admin: all; management: their own partner).
create or replace function public.count_pending_tenancy_corrections()
returns integer
language sql security definer set search_path to ''
as $function$
  select count(*)::int
  from public.tenancy_correction_tokens t
  join public.applications a on a.id = t.application_id
  where t.submitted_at is not null and t.resolved_at is null
    and public.is_aal2()
    and (public.is_admin() or (public.app_role() = 'management' and a.partner_id = public.app_partner()));
$function$;

revoke execute on function public.count_pending_tenancy_corrections() from public, anon;
grant execute on function public.count_pending_tenancy_corrections() to authenticated;
