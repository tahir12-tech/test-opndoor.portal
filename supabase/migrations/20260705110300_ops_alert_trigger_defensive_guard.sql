-- #3 hardening: wrap the alert side-effects in a nested exception handler so a
-- failure in the alerting path (ops_alerts insert, ops_secrets read, net.http_post)
-- can NEVER roll back the legitimate activity_log insert that the trigger observes.
-- (Under a correctly provisioned project none of these raise, but the guard removes
-- any residual risk of an alert side-effect aborting a business transaction.)
create or replace function public.alert_ops_on_failure()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare v_secret text; v_rows int;
  v_url text := 'https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/ops-alert';
begin
  if new.kind not in (
    'deed_error','deed_delivery_failed','deed_reminder_failed','deed_undelivered',
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

create or replace function public.report_ops_incident(p_type text, p_detail text)
returns void language plpgsql security definer set search_path to '' as $function$
declare v_secret text; v_rows int;
  v_url text := 'https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/ops-alert';
begin
  begin
    insert into public.ops_alerts (alert_type, application_id, hour_bucket, detail)
    values (p_type, null, date_trunc('hour', now()), left(coalesce(p_detail,''), 500))
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then return; end if;
    select secret into v_secret from public.ops_secrets where name = 'reminders_cron';
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type','application/json','x-ops-secret', coalesce(v_secret,'')),
      body := jsonb_build_object('alert_type', p_type, 'application_id', null, 'message', coalesce(p_detail,''))
    );
  exception when others then
    null; -- best effort: never propagate an alerting failure to the caller
  end;
end $function$;
