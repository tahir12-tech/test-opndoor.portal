-- A refund must expire the tenant's PandaDoc signing link. When that void cannot
-- be confirmed the application logs 'deed_void_failed', but that kind was not in
-- the ops-alert trigger's list, so the only alert came from report_ops_incident —
-- which records application_id null and therefore dedupes to ONE alert per hour
-- across every application. A live signing link left on a refunded application is
-- exactly the case that must never be deduped away, so the kind is added here and
-- alerts per application. Function body otherwise unchanged.
create or replace function public.alert_ops_on_failure()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare v_secret text; v_rows int;
  v_url text := 'https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/ops-alert';
begin
  if new.kind not in (
    'deed_error','deed_delivery_failed','deed_reminder_failed','deed_undelivered',
    'deed_void_failed',
    'expiry_reminder_email_failed','payment_reminder_email_failed',
    'payment_email_failed','refund_email_failed','refund_anomaly','payment_anomaly'
  ) then
    return new;
  end if;
  begin
    insert into public.ops_alerts (alert_type, application_id, hour_bucket, detail)
    values (new.kind, new.application_id, date_trunc('hour', now()), left(new.message, 500))
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then return new; end if; -- already alerted for this type+app this hour
    select secret into v_secret from public.ops_secrets where name = 'reminders_cron';
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type','application/json','x-ops-secret', coalesce(v_secret,'')),
      body := jsonb_build_object('alert_type', new.kind, 'application_id', new.application_id, 'message', new.message)
    );
  exception when others then
    null; -- best effort: a failed alert must never break the logged operation
  end;
  return new;
end $function$;
