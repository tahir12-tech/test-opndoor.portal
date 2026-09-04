-- Block a late PandaDoc completion webhook after the payment was refunded.
-- The deed_error activity entry is handled by the existing ops-alert trigger.
create or replace function public.apply_deed_executed(p_document_id text, p_pdf_path text)
  returns void
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare a public.applications;
begin
  select * into a
  from public.applications
  where pandadoc_document_id = p_document_id;

  if not found then
    return;
  end if;

  if a.payment_state = 'refunded' then
    insert into public.activity_log(application_id, kind, message, actor, visibility)
    values (
      a.id,
      'deed_error',
      'Blocked PandaDoc completion because payment was already refunded.',
      'System',
      'internal'
    );
    return;
  end if;

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

-- Clear existing refunded applications that still expose a signing document.
update public.applications
set
  deed_state = 'voided',
  pandadoc_document_id = null
where payment_state = 'refunded'
  and deed_state = 'awaiting_tenant'
  and pandadoc_document_id is not null;