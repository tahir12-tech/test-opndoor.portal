-- Bound the rate_limit table (adversarial review: rows were never evicted).
-- UNLOGGED: this is ephemeral throttling state, so keep it out of the WAL and off
-- replicas; losing it on crash recovery just resets counters, which is fine.
alter table public.rate_limit set unlogged;

-- Index the eviction predicate, and reclaim expired rows hourly so distinct keys
-- (IPs / session ids) cannot accumulate without limit.
create index if not exists rate_limit_window_start_idx on public.rate_limit (window_start);

select cron.schedule(
  'rate-limit-cleanup',
  '7 * * * *',
  $$delete from public.rate_limit where window_start < now() - interval '1 hour'$$
);
