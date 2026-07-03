-- Issue date is now set at generation (= the date printed on the deed). The
-- completion webhook must leave it untouched; deed_issued_at remains the
-- execution timestamp.
create or replace function public.apply_deed_executed(p_document_id text, p_pdf_path text)
  returns void
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare a public.applications;
begin
  select * into a from public.applications where pandadoc_document_id = p_document_id;
  if not found then return; end if;
  if a.status = 'paid' then
    update public.applications set
      status            = 'deed',
      deed_state        = 'executed',
      deed_executed_at  = coalesce(deed_executed_at, now()),
      deed_issued_at    = coalesce(deed_issued_at, now()),
      executed_pdf_path = coalesce(p_pdf_path, executed_pdf_path)
    where id = a.id;
  else
    update public.applications set
      deed_state        = 'executed',
      deed_executed_at  = coalesce(deed_executed_at, now()),
      executed_pdf_path = coalesce(executed_pdf_path, p_pdf_path)
    where id = a.id;
  end if;
end $function$;
