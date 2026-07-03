-- Rate limiting for public (verify_jwt=false) Edge Functions, e.g. the tenant
-- payment-confirmation endpoint. One row per key (IP or Stripe session id) with a
-- rolling fixed window; the window resets once it expires, so the table stays
-- small (bounded by distinct active clients). Service-role only.
create table if not exists public.rate_limit (
  key text primary key,
  hits int not null default 0,
  window_start timestamptz not null default now()
);
alter table public.rate_limit enable row level security;
-- No policies: anon/authenticated are fully denied; only service_role (which
-- bypasses RLS) reads/writes it via bump_rate_limit.

-- Atomically record a hit and report whether the caller is within the limit.
-- Returns true when allowed, false when the limit is exceeded for the window.
create or replace function public.bump_rate_limit(p_key text, p_limit int, p_window_secs int)
  returns boolean
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare v_hits int;
begin
  insert into public.rate_limit (key, hits, window_start)
    values (p_key, 1, now())
  on conflict (key) do update set
    hits = case when public.rate_limit.window_start < now() - make_interval(secs => p_window_secs)
                then 1 else public.rate_limit.hits + 1 end,
    window_start = case when public.rate_limit.window_start < now() - make_interval(secs => p_window_secs)
                        then now() else public.rate_limit.window_start end
  returning hits into v_hits;
  return v_hits <= p_limit;
end $function$;

revoke all on function public.bump_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.bump_rate_limit(text, int, int) to service_role;
