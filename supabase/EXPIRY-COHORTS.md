# Expiry cohorts (#86)

The `expiry-cohorts` Edge Function emails each partner's Management the cohort of
guarantees expiring in a calendar month, soonest first, as a CSV attachment, six
weeks before that month begins. Management and opndoor admin can also download
expiries for any month on demand from the dashboard (the Expiries button).

Design mirrors `expiry-reminders`:

- **pg_cron + service-role Edge Function.** Two daily jobs at 07:00 and 08:00 UTC;
  the function self-gates to exactly 08:00 Europe/London so the off-hour run
  no-ops (survives BST/GMT). `verify_jwt = false`.
- **Fire day.** On the day when `today + 42 days` is the 1st of a month, the
  function builds that month's cohort per partner and emails Management.
- **Idempotency.** `expiry_cohort_sends(partner_id, cohort_month)` records one row
  per partner-month, so reruns/overlap never double-email.
- **Auth.** `x-reminders-secret == REMINDERS_CRON_SECRET` (reused, never
  committed), or a signed-in opndoor-admin JWT with `{ "test": true }` for a
  manual run. A test run may pass `{ "month": "YYYY-MM" }`.
- **Columns** are identical to the on-demand `buildExpiriesCsv` (exportsService):
  guarantee reference, tenant name, property address, agency, branch, tenancy
  start, expiry date, days remaining, monthly rent, annualised rent, referrer.
- **Test build** redirects every email to `EMAIL_REVIEW_ADDRESS`.

## Schedule (run once, in the SQL editor)

Store the cron secret in Vault, then schedule two daily jobs (as for
expiry-reminders). Replace `<PROJECT-REF>` and use the anon key as `apikey`.

```sql
-- Vault secret (once): select vault.create_secret('<REMINDERS_CRON_SECRET>', 'reminders_cron_secret');
select cron.schedule('expiry-cohorts-0700', '0 7 * * *', $$
  select net.http_post(
    url    := 'https://<PROJECT-REF>.supabase.co/functions/v1/expiry-cohorts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<ANON-KEY>',
      'x-reminders-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')
    ),
    body := '{}'::jsonb
  );
$$);
select cron.schedule('expiry-cohorts-0800', '0 8 * * *', $$
  select net.http_post(
    url    := 'https://<PROJECT-REF>.supabase.co/functions/v1/expiry-cohorts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<ANON-KEY>',
      'x-reminders-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')
    ),
    body := '{}'::jsonb
  );
$$);
```
