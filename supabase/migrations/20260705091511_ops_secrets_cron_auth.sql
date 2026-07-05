-- INCIDENT #1 (auth half): every reminder cron was returning 401 because the edge
-- functions' REMINDERS_CRON_SECRET env had drifted from the Vault secret the crons
-- present (confirmed: expiry-reminders' 08:00 call today returned 401). Edge secrets
-- cannot be set from here, so the reminder functions now ALSO accept the cron secret
-- from this service-role-only mirror table, which holds the same value the crons send.
-- The crons are unchanged; the functions become resilient to a drifted/unset edge env.
--
-- The row itself is seeded out-of-band (from the Vault secret, via SQL) so the secret
-- value is never committed:
--   insert into public.ops_secrets(name, secret)
--   select 'reminders_cron', decrypted_secret from vault.decrypted_secrets
--   where name = 'reminders_cron_secret'
--   on conflict (name) do update set secret = excluded.secret, updated_at = now();
create table if not exists public.ops_secrets (
  name text primary key,
  secret text not null,
  updated_at timestamptz not null default now()
);
-- Service-role only (no policies): the reminder Edge Functions read it with the
-- service role, which bypasses RLS; anon/authenticated are blocked entirely.
alter table public.ops_secrets enable row level security;
