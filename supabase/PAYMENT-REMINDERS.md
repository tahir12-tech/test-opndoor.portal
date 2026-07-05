# Payment reminders (Incident 5 July 2026)

The `payment-reminders` Edge Function chases UNPAID guarantor fees: it reminds the
tenant at 2, 5 and 9 days after an application was Sent while the fee is still
unpaid, reusing the branded payment email + the existing Checkout link.

## The incident

On Sunday 5 July the "8am payment reminder" did not deliver. Two root causes:

1. **The payment-reminder system did not exist.** Only deed-EXPIRY reminders
   (`expiry-reminders`) and a MANUAL resend (`resend-payment-email`) were built.
   No pg_cron job and no edge function chased unpaid fees, so nothing fired.
2. **All reminder crons were silently 401ing.** The edge functions'
   `REMINDERS_CRON_SECRET` env had drifted from the Vault secret the crons present
   (`net._http_response` showed the 08:00 expiry-reminders call returned 401). The
   pg_cron jobs "succeeded" (the `net.http_post` SQL ran) while the function
   rejected the call, so it looked healthy in `cron.job_run_details`.

## The fix

- Built the missing system: `payment_reminders` ledger + `fire_payment_reminders`
  RPC (mirrors the expiry-reminder design) + the `payment-reminders` function.
- Cron-auth resilience: a service-role-only `public.ops_secrets` table mirrors the
  Vault cron secret; the reminder functions (`payment-reminders`,
  `expiry-reminders`, `expiry-cohorts`) now accept the presented `x-reminders-secret`
  if it matches the edge env OR `ops_secrets`. The crons are unchanged (they pass
  the Vault secret, which the mirror holds), so they authenticate again without
  needing an edge-secret change. Re-point the edge env to the Vault value when
  convenient and the mirror becomes a belt-and-braces fallback.
- Scheduled two daily jobs (07:00 + 08:00 UTC); the function self-gates to 08:00
  Europe/London (BST/GMT safe).
- Forced one review-redirected run so this morning's stuck-at-Sent applications
  were reminded.

## Verify / manual run

A cron-authenticated run with `{test:true}` bypasses the 08:00 gate:

```sql
select net.http_post(
  url := 'https://<PROJECT-REF>.supabase.co/functions/v1/payment-reminders',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'apikey', '<ANON-KEY>',
    'x-reminders-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')),
  body := '{"test": true}'::jsonb);
-- then inspect: select status_code, content from net._http_response order by id desc limit 1;
```
