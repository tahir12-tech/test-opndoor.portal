alter table public.applications
  add column pandadoc_document_id text,
  add column deed_state text check (deed_state in ('awaiting_tenant','executed','declined','voided','error')),
  add column deed_sent_at timestamptz,
  add column deed_executed_at timestamptz,
  add column executed_pdf_path text;

create table public.pandadoc_events (
  id text primary key,
  type text not null,
  application_id uuid references public.applications(id) on delete set null,
  received_at timestamptz not null default now()
);
alter table public.pandadoc_events enable row level security;

-- Completion: tenant signed -> Paid to Deed Issued. Service-role, idempotent
-- (the deed twin of apply_stripe_payment).
create or replace function public.apply_deed_executed(p_document_id text, p_pdf_path text)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.applications;
begin
  select * into a from public.applications where pandadoc_document_id = p_document_id;
  if not found then return; end if;
  if a.status = 'paid' then
    update public.applications set
      status           = 'deed',
      deed_state       = 'executed',
      deed_executed_at = coalesce(deed_executed_at, now()),
      deed_issued_at   = coalesce(deed_issued_at, now()),
      issue_date       = coalesce(issue_date, current_date),
      executed_pdf_path = coalesce(p_pdf_path, executed_pdf_path)
    where id = a.id;
  else
    update public.applications set
      deed_state        = 'executed',
      deed_executed_at  = coalesce(deed_executed_at, now()),
      executed_pdf_path = coalesce(executed_pdf_path, p_pdf_path)
    where id = a.id;
  end if;
end $$;

create or replace function public.set_deed_state(p_document_id text, p_state text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_state not in ('awaiting_tenant','executed','declined','voided','error') then
    raise exception 'invalid deed state';
  end if;
  update public.applications set deed_state = p_state where pandadoc_document_id = p_document_id;
end $$;

revoke execute on function public.apply_deed_executed(text, text) from public, anon, authenticated;
revoke execute on function public.set_deed_state(text, text) from public, anon, authenticated;
grant execute on function public.apply_deed_executed(text, text) to service_role;
grant execute on function public.set_deed_state(text, text) to service_role;

-- Private bucket for executed deed PDFs.
insert into storage.buckets (id, name, public) values ('deeds', 'deeds', false) on conflict (id) do nothing;
