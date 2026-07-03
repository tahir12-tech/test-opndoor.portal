# Automated expiry reminders - setup and test runbook

The scheduled job that proactively reminds referrers and partner management that a
Deed of Guarantee is approaching expiry. Sandbox/test build: emails are redirected
to `EMAIL_REVIEW_ADDRESS` and degrade gracefully while the domain is unverified.

## Design choice: pg_cron + a service-role Edge Function

`pg_cron` (with `pg_net`) invokes the `expiry-reminders` Edge Function daily. Why
this split: the reminder work needs the branded Resend email template and a
service-role database pass, which belong in an Edge Function (Deno); pg_cron gives
a reliable, in-database daily schedule. The function self-gates to **08:00
Europe/London** - the cron fires at both 07:00 and 08:00 UTC so exactly one run
lands at 08:00 London year-round (BST vs GMT); the off-hour invocation no-ops.
Idempotency makes any overlap or rerun harmless.

## Behaviour

For every in-force guarantee (**Deed Issued, not refunded**) it computes days to
expiry from `expiry_date` (the `guarantee_expiry` rule: tenancy start + 12 months
- 1 day) and fires a reminder as the count crosses **30, 14, 7**, then **daily from
6 down to 0** (the final week). Each `(application, threshold)` is recorded in
`expiry_reminders`, so every tier fires **exactly once**, idempotent across reruns.
Each new reminder is delivered as:
- **(a)** a business-visible activity entry ("Expiry reminder: guarantee expires in
  N days (dd/mm/yyyy)."), and
- **(b)** a branded Resend email to the **owning referrer** and **partner
  management** (redirected to the review address in this build).

Graceful degradation: if the email fails (e.g. Resend domain unverified -> 403) the
raw error is logged `internal` (opndoor admin only) and the run continues - partners
still get the in-app reminder; no raw 403 reaches them. A per-guarantee
`expiry_reminders_sent` count surfaces as a "reminders sent" indicator on the
Activity page's upcoming-expiries rows.

## What is already applied

- **Schema** (migration `expiry_reminder_schema`): table `expiry_reminders`
  (idempotency ledger), `applications.expiry_reminders_sent` /
  `last_expiry_reminder_at`, and the service-role RPC `fire_expiry_reminders(date)`.
- **Extensions**: `pg_cron` and `pg_net` enabled.
- **Function**: `expiry-reminders` deployed (`verify_jwt` off; it authenticates via
  the cron secret or an opndoor-admin JWT).
- **Secret**: `REMINDERS_CRON_SECRET` is set as an Edge Function secret.

## 1. Email dependencies (shared with the other emails)

| Secret | Purpose |
|---|---|
| `RESEND_API_KEY` | Sends the reminder email. Without it, reminders still fire in-app; email is reported as not sent. |
| `EMAIL_REVIEW_ADDRESS` | TEST SAFETY: every reminder email is redirected here. |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | Optional; defaults `opndoor <payments@opndoor.co>` / `hello@opndoor.co`. |

## 2. Schedule the daily job (secret kept in Vault)

Run this once in the SQL editor. The secret lives in Vault, so it is never written
literally into `cron.job`.

```sql
-- (a) Store the shared secret in Vault. Use the SAME value set as the
--     REMINDERS_CRON_SECRET Edge Function secret.
select vault.create_secret('68fHYu64R0q4BgBWcusdqFe1KyCTA4lL', 'reminders_cron_secret', 'expiry-reminders cron');

-- (b) Two daily jobs (07:00 + 08:00 UTC). The function runs at exactly 08:00
--     Europe/London and the off-hour call no-ops.
select cron.schedule('expiry-reminders-0700', '0 7 * * *', $c$
  select net.http_post(
    url := 'https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/expiry-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<anon publishable key>',
      'x-reminders-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')),
    body := '{}'::jsonb);
$c$);

select cron.schedule('expiry-reminders-0800', '0 8 * * *', $c$
  select net.http_post(
    url := 'https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/expiry-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<anon publishable key>',
      'x-reminders-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')),
    body := '{}'::jsonb);
$c$);

-- Verify / manage
select jobname, schedule, active from cron.job where jobname like 'expiry-reminders%';
-- select cron.unschedule('expiry-reminders-0700');  -- to remove
```

The `apikey` is the public publishable/anon key (safe to place here); the secret
comes from Vault. Cron schedules are evaluated in UTC.

## 3. Verify today (manual test mode)

Two ways, both bypassing the 08:00 gate and running against today's expiring
guarantees. Idempotent: a second run fires nothing new.

- **UI (opndoor admin):** Activity page -> "Run reminders (test)" (top-right of
  Upcoming expiries). It runs the job, refreshes, and toasts `N fired, M emailed,
  K failed`. The "N sent" indicator on each row updates; the reminder shows on each
  application's activity feed.
- **curl (cron-secret path):**
  ```
  curl -X POST 'https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/expiry-reminders' \
    -H 'apikey: <anon publishable key>' \
    -H 'x-reminders-secret: <REMINDERS_CRON_SECRET>' \
    -H 'Content-Type: application/json' \
    -d '{"test":true,"reset":true}'
  ```
  Body options (test only): `{"date":"YYYY-MM-DD"}` overrides "today";
  `{"reset":true}` clears the windowed ledger first so the run can be repeated.

Against the seed (today 03/07/2026) this fires 6 reminders: GR-19064 (d0),
GR-19015 (d2), GR-19022 (d6), GR-19050 (14), GR-19029 (14), GR-19036 (30). Already
expired guarantees (days < 0) are skipped.

## Inspect state

```sql
select a.guarantee_ref, er.threshold, er.days_at_send, er.sent_at
from public.expiry_reminders er join public.applications a on a.id = er.application_id
order by er.sent_at desc;

select kind, visibility, message from public.activity_log
where kind like 'expiry_reminder%' order by at desc limit 20;
```

## Notes

- `fire_expiry_reminders` is service-role only (revoked from public/anon/
  authenticated); it writes the ledger + business activity and returns the new
  reminders for the function to email. The Edge Function logs email failures
  `internal`.
- Threshold keys: `'30'` (15-30 days), `'14'` (8-14), `'7'` (day 7), then `'d6'..'d0'`
  (final week). One key per guarantee per day; the ledger PK guarantees once-only.
- Redeploy after edits: `npx supabase functions deploy expiry-reminders
  --project-ref pwftaqtrrqtilxlvwxjd --no-verify-jwt`.
