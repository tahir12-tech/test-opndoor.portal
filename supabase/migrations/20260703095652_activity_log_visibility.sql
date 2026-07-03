alter table public.activity_log
  add column if not exists visibility text not null default 'business';

alter table public.activity_log
  drop constraint if exists activity_log_visibility_check;
alter table public.activity_log
  add constraint activity_log_visibility_check check (visibility in ('business','internal'));

-- Backfill: raw technical failures become opndoor-admin-only.
update public.activity_log
  set visibility = 'internal'
  where kind in ('deed_error', 'payment_email_failed');
