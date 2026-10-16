-- THE SAME FAILURE SAYS SO ONCE AN HOUR.
--
-- Live, 15 October 2026: Resend refused every send from 16:14 with a daily
-- quota 429, and the quota had gone on a retry loop rather than on deeds.
-- report_ops_incident spoke whenever the DETAIL TEXT CHANGED, and hubspot-sync
-- puts the attempt number in its detail, so every retry sent another email.
-- hubspot_sync_events holds 288 `fail:` rows across three applications, each
-- one an email to support@opndoor.co.
--
-- The ops_alerts log hid it: its insert is `on conflict do nothing` on an
-- hourly bucket, so the table showed five rows for the day. `last_at` on
-- ops_alert_state is the honest signal, because it moves ONLY when we speak,
-- and it is what every assertion below reads.
--
-- 20261015120000 adds a floor: changed detail speaks at most once an hour.

begin;
select plan(8);

create temp table snap (label text primary key, at timestamptz);

-- A type nothing else uses, so a real alert cannot drift into the assertions.
delete from public.ops_alert_state where alert_type = 'zzz_loop_probe';
delete from public.ops_alerts where alert_type = 'zzz_loop_probe';

-- ---------------------------------------------------------------------------
-- A NEW FAILURE IS ALWAYS SAID.
-- ---------------------------------------------------------------------------
select public.report_ops_incident('zzz_loop_probe', 'sync failed (attempt 1)');
insert into snap values ('first', (select last_at from public.ops_alert_state
                                    where alert_type = 'zzz_loop_probe'));

select ok((select at from snap where label = 'first') is not null,
  'a failure nobody has heard about is reported');

select is((select count(*)::int from public.ops_alerts where alert_type = 'zzz_loop_probe'), 1,
  'and it is logged once');

-- ---------------------------------------------------------------------------
-- THE RETRY TWO MINUTES LATER IS NOT. This is the loop: same failure, new
-- attempt number, so the old gate called it new information.
-- ---------------------------------------------------------------------------
select public.report_ops_incident('zzz_loop_probe', 'sync failed (attempt 2)');
select public.report_ops_incident('zzz_loop_probe', 'sync failed (attempt 3)');

select is((select last_at from public.ops_alert_state where alert_type = 'zzz_loop_probe'),
          (select at from snap where label = 'first'),
  'the same failure with a new attempt number is NOT emailed again');

/* THE DETAIL STILL MOVES ON, even while we stay quiet, so the next comparison
   is against what is actually happening now rather than against the first
   thing we happened to say. */
select is((select detail from public.ops_alert_state where alert_type = 'zzz_loop_probe'),
          'sync failed (attempt 3)',
  'though the state keeps the newest detail, so the next hour compares against now');

-- ---------------------------------------------------------------------------
-- AN HOUR LATER IT IS SAID AGAIN, because a failure still failing is worth a
-- reminder and an hour is the resolution the log already keeps.
-- ---------------------------------------------------------------------------
update public.ops_alert_state set last_at = now() - interval '61 minutes'
 where alert_type = 'zzz_loop_probe';
select public.report_ops_incident('zzz_loop_probe', 'sync failed (attempt 40)');

select ok((select last_at from public.ops_alert_state where alert_type = 'zzz_loop_probe')
          > now() - interval '1 minute',
  'an hour on, a changed detail is reported again');

-- ---------------------------------------------------------------------------
-- BUT AN UNCHANGED DETAIL STILL WAITS A DAY, which is the behaviour that was
-- already there and must not be tightened by accident.
-- ---------------------------------------------------------------------------
update public.ops_alert_state set last_at = now() - interval '61 minutes',
       detail = 'steady state failure'
 where alert_type = 'zzz_loop_probe';
insert into snap values ('hour_ago', (select last_at from public.ops_alert_state
                                       where alert_type = 'zzz_loop_probe'));
select public.report_ops_incident('zzz_loop_probe', 'steady state failure');

select is((select last_at from public.ops_alert_state where alert_type = 'zzz_loop_probe'),
          (select at from snap where label = 'hour_ago'),
  'an identical detail an hour later is still silent: that one waits a day');

update public.ops_alert_state set last_at = now() - interval '25 hours'
 where alert_type = 'zzz_loop_probe';
select public.report_ops_incident('zzz_loop_probe', 'steady state failure');

select ok((select last_at from public.ops_alert_state where alert_type = 'zzz_loop_probe')
          > now() - interval '1 minute',
  'and after a day the same failure reminds us it is still there');

-- ---------------------------------------------------------------------------
-- AND A GENUINELY DIFFERENT ALERT IS NEVER HELD BACK BY ANOTHER ONE'S CLOCK.
-- The floor is per (type, application), not global, or one noisy failure would
-- silence everything else.
-- ---------------------------------------------------------------------------
select public.report_ops_incident('zzz_loop_probe_other', 'a different failure entirely');
select ok((select last_at from public.ops_alert_state
            where alert_type = 'zzz_loop_probe_other') is not null,
  'a different alert type speaks immediately, whatever the first one is doing');

select * from finish();
rollback;
