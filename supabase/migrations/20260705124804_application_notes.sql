-- #8 Operational notes on applications. Free-text, internal-only notes shown on
-- the application detail page. Visible to management + opndoor admin + the owning
-- referrer only; append-only (no edits/deletes); never syncs, exports, or appears
-- on any tenant/agent surface. Writes go solely through add_application_note
-- (SECURITY DEFINER); there is no client insert policy.
create table public.app_notes (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  body           text not null,
  author         text,
  author_id      uuid references public.users(id),
  at             timestamptz not null default now()
);
create index app_notes_app_idx on public.app_notes (application_id, at desc);

alter table public.app_notes enable row level security;
-- Visible when the caller can see the referenced application (inner select is RLS-scoped
-- to management / opndoor admin / owning referrer, exactly like the activity log).
create policy app_notes_select on public.app_notes for select to authenticated
  using (application_id in (select id from public.applications));
create policy require_aal2 on public.app_notes as restrictive for all to authenticated
  using (public.is_aal2()) with check (public.is_aal2());
-- Writes happen only via add_application_note below (service role / RPC); no insert policy.

-- Append one operational note to an application, addressed by guarantee_ref (as the
-- client holds it). Permission mirrors mark_withdrawn: opndoor admin, or management on
-- their own partner, or the owning referrer. AAL2 required. The body is trimmed,
-- required (non-empty), and capped at 2000 chars. Author + author_id are the caller.
create or replace function public.add_application_note(p_ref text, p_body text)
returns public.app_notes
language plpgsql security definer set search_path to ''
as $function$
declare a public.applications; r text; owned boolean; b text; n public.app_notes;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into a from public.applications where guarantee_ref = p_ref;
  if not found then raise exception 'application not found'; end if;
  r := public.app_role();
  owned := a.referrer_id = auth.uid();
  if not (public.is_admin() or (r = 'management' and a.partner_id = public.app_partner()) or (r = 'referrer' and owned)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  b := btrim(coalesce(p_body, ''));
  if b = '' then raise exception 'A note cannot be empty.' using errcode = '22023'; end if;
  insert into public.app_notes(application_id, body, author, author_id)
  values (a.id, left(b, 2000), (select full_name from public.users where id = auth.uid()), auth.uid())
  returning * into n;
  return n;
end $function$;
revoke execute on function public.add_application_note(text, text) from public, anon;
grant execute on function public.add_application_note(text, text) to authenticated;
