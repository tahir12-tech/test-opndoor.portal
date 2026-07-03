create table public.activity_log (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  kind           text not null,
  message        text not null,
  actor          text,
  at             timestamptz not null default now()
);
create index activity_log_app_idx on public.activity_log (application_id, at desc);

alter table public.activity_log enable row level security;
-- Visible when the caller can see the referenced application (inner select is RLS-scoped).
create policy activity_log_select on public.activity_log for select to authenticated
  using (application_id in (select id from public.applications));
create policy require_aal2 on public.activity_log as restrictive for all to authenticated
  using (public.is_aal2()) with check (public.is_aal2());
-- Writes happen via the service role (Edge Functions), which bypasses RLS.;
