# Weekly partner digest (#4)

The `weekly-digest` Edge Function emails each partner's Management a branded "week
at a glance" every Monday: the last 7 days' referrals sent, guarantor fees paid,
fees collected, Sent to Paid conversion, deeds issued, top branch by fees, and the
current awaiting-signature count.

Design mirrors `expiry-cohorts` / `expiry-reminders`:

- **pg_cron + service-role Edge Function.** Two jobs every Monday at 07:00 and
  08:00 UTC; the function self-gates to exactly 08:00 Europe/London (so the
  off-hour run no-ops and it survives BST/GMT) **and to Monday only**.
  `verify_jwt = false`.
- **Window.** Reports the 7 days ending at the run's Monday 00:00, i.e. the
  previous Monday to Sunday. Figures use the same event-in-period basis as the
  live dashboard: Sent by `sent_at`, Paid and fees by `paid_at`, Deeds by
  `deed_issued_at`. Withdrawn referrals are excluded from Sent (matching the
  dashboards and Leagues). "Awaiting signature" is a current-state count.
- **Numbers** come from the `partner_weekly_digest(p_start, p_end)` RPC (one row
  per partner). The edge function computes Sent to Paid as `paid / sent` and
  suppresses the top branch when no branch collected a fee that week.
- **Idempotency.** `partner_digest_sends(partner_id, week_start)` records one row
  per partner-week, so reruns/overlap never double-email.
- **Quiet weeks.** A partner with no referrals sent, paid, or deeds issued in the
  window is skipped (no all-zero email); partners with no Management user are also
  skipped.
- **Auth.** `x-reminders-secret == REMINDERS_CRON_SECRET` (reused, never
  committed) or the `ops_secrets` mirror, or a signed-in opndoor-admin JWT with
  `{ "test": true }` for a manual run. A test run may pass
  `{ "weekStart": "YYYY-MM-DD" }` (the Monday whose prior 7 days to report).
- **Test build** redirects every email to `EMAIL_REVIEW_ADDRESS`.

## Schedule (run once, in the SQL editor)

Reuses the same Vault cron secret as the other jobs. Replace `<PROJECT-REF>` and
use the anon key as `apikey`.

```sql
select cron.schedule('weekly-digest-0700', '0 7 * * 1', $$
  select net.http_post(
    url    := 'https://<PROJECT-REF>.supabase.co/functions/v1/weekly-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<ANON-KEY>',
      'x-reminders-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')
    ),
    body := '{}'::jsonb
  );
$$);
select cron.schedule('weekly-digest-0800', '0 8 * * 1', $$
  select net.http_post(
    url    := 'https://<PROJECT-REF>.supabase.co/functions/v1/weekly-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<ANON-KEY>',
      'x-reminders-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')
    ),
    body := '{}'::jsonb
  );
$$);
```
