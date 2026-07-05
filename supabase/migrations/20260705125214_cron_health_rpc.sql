-- #7 opndoor operational health page: a single admin-gated RPC that surfaces
-- cron liveness AND the REAL HTTP outcome of each cron call.
--
-- WHY net._http_response matters: the reminder crons only run
--   `select net.http_post(...)`, so cron.job_run_details.status reports
--   'succeeded' the moment the request is *queued* — even when the edge
--   function later answers 401 (the silent-401 class, INCIDENT #1). The true
--   HTTP status lives in net._http_response. cron / net are non-public schemas
--   a client cannot read, so this SECURITY DEFINER function reads them and
--   self-gates to an AAL2 admin.
create or replace function public.cron_health()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_since        timestamptz := now() - interval '24 hours';
  v_jobs         jsonb;
  v_recent_http  jsonb;
  v_http_alert   boolean;
  v_counts       jsonb;
  v_needs        jsonb;
begin
  -- Self-gate: MFA first, then admin. Both raise 42501 (insufficient privilege).
  if not public.is_aal2() then
    raise exception 'MFA required' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- Cron jobs: schedule + latest run + a best-effort HTTP outcome.
  -- net._http_response does NOT store the request URL, so per-job correlation
  -- is done by time (the nearest response created within 5 minutes of the run
  -- start). It is best-effort and can be ambiguous when two jobs fire in the
  -- same minute; recent_http (below) is the authoritative HTTP signal.
  select coalesce(jsonb_agg(obj order by jobname), '[]'::jsonb)
  into v_jobs
  from (
    select
      job.jobname as jobname,
      jsonb_build_object(
        'jobname', job.jobname,
        'schedule', job.schedule,
        'active', job.active,
        'last_status', lr.status,
        'last_return_message', lr.return_message,
        'last_run', lr.start_time,
        'last_end', lr.end_time,
        'http_status_code', hr.status_code,
        'http_created', hr.created,
        'http_ok', case when hr.status_code is null then null
                        else hr.status_code between 200 and 299 end
      ) as obj
    from cron.job job
    left join lateral (
      select d.status, d.return_message, d.start_time, d.end_time
      from cron.job_run_details d
      where d.jobid = job.jobid
      order by d.start_time desc nulls last
      limit 1
    ) lr on true
    left join lateral (
      select r.status_code, r.created
      from net._http_response r
      where lr.start_time is not null
        and r.created >= lr.start_time
        and r.created <  lr.start_time + interval '5 minutes'
      order by r.created asc
      limit 1
    ) hr on true
  ) s;

  -- The authoritative HTTP surface: the most recent responses, with status,
  -- a 2xx flag and a content snippet so a silent 401 is impossible to miss.
  select coalesce(jsonb_agg(obj order by created desc), '[]'::jsonb)
  into v_recent_http
  from (
    select
      r.created as created,
      jsonb_build_object(
        'id', r.id,
        'status_code', r.status_code,
        'ok', case when r.status_code is null then false
                   else r.status_code between 200 and 299 end,
        'created', r.created,
        'content', left(r.content, 160),
        'error_msg', r.error_msg,
        'timed_out', r.timed_out
      ) as obj
    from net._http_response r
    order by r.created desc
    limit 10
  ) s;

  -- Top-level flag: is the single most recent HTTP response a non-2xx?
  select (r.status_code is null or r.status_code not between 200 and 299)
  into v_http_alert
  from net._http_response r
  order by r.created desc
  limit 1;
  v_http_alert := coalesce(v_http_alert, false);

  -- 24h failure/volume counts, from the signals the system already records.
  select jsonb_build_object(
    'window_hours', 24,
    'email_sends', (
      select count(*) from public.activity_log
      where at > v_since and kind in (
        'payment_email_sent','payment_email_resent','payment_reminder',
        'payment_reminder_email_sent','expiry_reminder_email_sent',
        'refund_email_sent','payment_receipt_sent','tenant_deed_email_sent')),
    'email_failures', (
      select count(*) from public.activity_log
      where at > v_since and kind in (
        'payment_email_failed','payment_reminder_email_failed',
        'expiry_reminder_email_failed','refund_email_failed',
        'payment_receipt_failed','tenant_deed_email_failed')),
    'webhook_failures', (
      select count(*) from public.ops_alerts
      where created_at > v_since and alert_type like 'webhook_error%'),
    'deed_failures', (
      select count(*) from public.activity_log
      where at > v_since and kind in ('deed_error','deed_delivery_failed')),
    'anomalies', (
      select count(*) from public.activity_log
      where at > v_since and kind in ('payment_anomaly','refund_anomaly')),
    'http_errors', (
      select count(*) from net._http_response
      where created > v_since
        and (status_code is null or status_code not between 200 and 299))
  ) into v_counts;

  -- Operational backlog that a human needs to clear.
  select jsonb_build_object(
    'stuck_sent', (
      select count(*) from public.applications where status = 'sent'),
    'awaiting_signature', (
      select count(*) from public.applications where deed_state = 'awaiting_tenant'),
    'pending_reconciliation', (
      (select count(*) from public.agencies where review_state = 'pending_review')
      + (select count(*) from public.branches where review_state = 'pending_review')),
    'pending_tenancy_corrections', (
      select count(*) from public.tenancy_correction_tokens
      where submitted_at is not null and resolved_at is null)
  ) into v_needs;

  return jsonb_build_object(
    'generated_at', now(),
    'http_alert', v_http_alert,
    'jobs', v_jobs,
    'recent_http', v_recent_http,
    'counts', v_counts,
    'needs_attention', v_needs
  );
end
$function$;

-- Locked down: the function self-gates to an AAL2 admin, but only signed-in
-- (authenticated) callers may invoke it at all; anon/public cannot.
revoke all on function public.cron_health() from public, anon;
grant execute on function public.cron_health() to authenticated;
