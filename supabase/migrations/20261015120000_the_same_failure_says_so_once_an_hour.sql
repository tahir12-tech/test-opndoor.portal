-- =====================================================================
-- THE SAME FAILURE SAYS SO ONCE AN HOUR, NOT EVERY TWO MINUTES.
--
-- Live, 15 October: Resend refused every send from 16:14 with
-- "429 You have reached your daily email sending quota", and the quota went on
-- a retry loop rather than on anybody's deeds.
--
-- report_ops_incident speaks when an alert is new, when it has been quiet for
-- 24 hours, OR WHEN THE DETAIL TEXT CHANGED. hubspot-sync builds its detail
-- with the attempt number inside it:
--
--   `${ev.kind} ${app?.guarantee_ref} (event ${ev.event_id}, attempt ${attempts})`
--
-- so every retry wrote a different detail, defeated the comparison, and sent
-- another email. The sync runs every two minutes. hubspot_sync_events holds 111
-- `fail:` rows for GR-20611, 111 for GR-20612 and 66 for GR-20613: 288 failed
-- attempts from three applications, each one an email to support@opndoor.co.
--
-- The ops_alerts LOG hid it. Its insert is `on conflict do nothing` on an
-- hourly bucket, so the table showed five rows for the day while the mail went
-- out every two minutes. Anybody checking the log would have concluded the
-- alerting was behaving.
--
-- THE FIX IS A FLOOR, NOT A REMOVAL. "The detail changed" is worth keeping: it
-- is how a failure that becomes a DIFFERENT failure gets said out loud instead
-- of hiding behind the first one for 24 hours. What it must not do is speak
-- more often than once an hour, which is already the resolution the ops_alerts
-- log keeps and is far finer than anybody reads their mail.
--
-- WHY NOT STRIP THE ATTEMPT NUMBER OUT OF hubspot-sync'S MESSAGE instead, which
-- was the other option on the table: it fixes one caller. The gate is shared by
-- every caller in the product, and the next one to put a counter, a timestamp
-- or a byte count in its detail would rediscover this at the cost of another
-- day's mail. The floor holds whatever anybody writes.
--
-- Everything else about the function is unchanged, including that last_at moves
-- only when we speak, so the hour is measured from the last thing anybody was
-- actually told.
-- =====================================================================

create or replace function public.report_ops_incident(
  p_type text, p_detail text, p_application_id uuid default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_secret text; v_base text;
        v_key uuid; v_prev text; v_last timestamptz; v_say boolean;
begin
  begin
    v_key := coalesce(p_application_id, '00000000-0000-0000-0000-000000000000'::uuid);

    select s.detail, s.last_at into v_prev, v_last
      from public.ops_alert_state s
     where s.alert_type = p_type and s.alert_key = v_key;

    /* IS THIS WORTH SAYING AGAIN? New, quiet for a day, or changed AND not
       said within the hour. The last clause is the whole of 20261015120000:
       without its floor an attempt counter in the detail turns a retry loop
       into a mail loop. */
    v_say := not found
             or v_last < now() - interval '24 hours'
             or (v_prev is distinct from left(coalesce(p_detail,''), 500)
                 and v_last < now() - interval '1 hour');

    insert into public.ops_alert_state (alert_type, alert_key, detail)
    values (p_type, v_key, left(coalesce(p_detail,''), 500))
    on conflict (alert_type, alert_key) do update
      set detail = excluded.detail,
          /* `last_at` moves only when we SPEAK. Touching it on every run
             would push the daily floor forward for ever and the reminder
             would never arrive. */
          last_at = case when v_say then clock_timestamp() else public.ops_alert_state.last_at end;

    if not v_say then return; end if;

    /* THE LOG, which keeps one row per type per hour and whose conflict is
       no longer allowed to swallow the notification below. */
    insert into public.ops_alerts (alert_type, application_id, hour_bucket, detail)
    values (p_type, p_application_id, date_trunc('hour', now()), left(coalesce(p_detail,''), 500))
    on conflict do nothing;

    v_base := public.ops_functions_base_url();
    if v_base is null then return; end if;

    select secret into v_secret from public.ops_secrets where name = 'reminders_cron';
    perform net.http_post(
      url := v_base || '/functions/v1/ops-alert',
      headers := jsonb_build_object('Content-Type','application/json','x-ops-secret', coalesce(v_secret,'')),
      body := jsonb_build_object('alert_type', p_type, 'application_id', p_application_id, 'message', coalesce(p_detail,''))
    );
  exception when others then
    null; -- best effort: never propagate an alerting failure to the caller
  end;
end $$;
