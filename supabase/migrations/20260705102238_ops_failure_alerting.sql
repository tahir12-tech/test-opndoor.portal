-- #3 Operational failure alerting. Every failure the system already writes to
-- activity_log (deed generation, email sends, delivery, anomalies) also fires an
-- ops alert email, deduped to at most one per failure type per application per
-- clock-hour. The email is sent by the ops-alert edge function; the trigger only
-- records the dedupe row and kicks the async pg_net call.

create table if not exists public.ops_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null,
  application_id uuid references public.applications(id) on delete cascade,
  hour_bucket timestamptz not null,
  detail text,
  created_at timestamptz not null default now()
);
-- Dedupe key: one row per (type, application, clock-hour). application_id is null
-- for infra alerts, so coalesce to a fixed sentinel uuid for the unique index.
create unique index if not exists ops_alerts_dedupe
  on public.ops_alerts (alert_type, coalesce(application_id, '00000000-0000-0000-0000-000000000000'::uuid), hour_bucket);
alter table public.ops_alerts enable row level security;
-- No policies: only service_role / SECURITY DEFINER paths touch this table.

create or replace function public.alert_ops_on_failure()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare v_secret text; v_rows int;
  v_url text := 'https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/ops-alert';
begin
  -- Only the failure kinds warrant an alert (single source of truth).
  if new.kind not in (
    'deed_error','deed_delivery_failed','deed_reminder_failed','deed_undelivered',
    'expiry_reminder_email_failed','payment_reminder_email_failed',
    'payment_email_failed','refund_email_failed','refund_anomaly','payment_anomaly'
  ) then
    return new;
  end if;
  -- Dedupe: at most one alert per (type, application, clock-hour).
  insert into public.ops_alerts (alert_type, application_id, hour_bucket, detail)
  values (new.kind, new.application_id, date_trunc('hour', now()), left(new.message, 500))
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return new; end if; -- already alerted for this type+app this hour
  -- Fire-and-forget branded email via the ops-alert edge function (pg_net, async).
  select secret into v_secret from public.ops_secrets where name = 'reminders_cron';
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','x-ops-secret', coalesce(v_secret,'')),
    body := jsonb_build_object('alert_type', new.kind, 'application_id', new.application_id, 'message', new.message)
  );
  return new;
end $function$;

drop trigger if exists trg_alert_ops_on_failure on public.activity_log;
create trigger trg_alert_ops_on_failure
  after insert on public.activity_log
  for each row execute function public.alert_ops_on_failure();

-- Infra failures (webhook / cron) that have no application row: a SECURITY DEFINER
-- entry point the edge functions can call from a catch block. It reuses the same
-- ops_alerts dedupe + ops-alert email path with a null application_id.
create or replace function public.report_ops_incident(p_type text, p_detail text)
returns void language plpgsql security definer set search_path to '' as $function$
declare v_secret text; v_rows int;
  v_url text := 'https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/ops-alert';
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
end $function$;
revoke execute on function public.report_ops_incident(text, text) from public, anon, authenticated;
grant execute on function public.report_ops_incident(text, text) to service_role;
