-- #86 Idempotency ledger for the monthly expiry-cohort email. The expiry-cohorts
-- cron emails each partner's Management the cohort of guarantees expiring in a
-- given month, six weeks before that month begins. One row per (partner, month)
-- guarantees each cohort is emailed exactly once across cron reruns/overlaps.
create table if not exists public.expiry_cohort_sends (
  partner_id uuid not null references public.partners(id) on delete cascade,
  cohort_month text not null,          -- 'YYYY-MM'
  recipients integer not null default 0,
  sent_at timestamptz not null default now(),
  primary key (partner_id, cohort_month)
);

-- Service-role only: written exclusively by the Edge Function (which bypasses
-- RLS). No client policies, so authenticated users can neither read nor write it.
alter table public.expiry_cohort_sends enable row level security;
