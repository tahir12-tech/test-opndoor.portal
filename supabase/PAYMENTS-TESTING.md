# Payments (Stripe test mode) - setup and test runbook

Strictly test mode. The Edge Functions refuse to run unless `STRIPE_SECRET_KEY`
is an `sk_test_` key, and the client only shows the TEST MODE badge for a
`pk_test_` key. Do not set any `sk_live` / `pk_live` value anywhere.

Flow: creating a referral IS the send. Submitting the New Application form
creates the application (Sent), opens a Stripe test Checkout Session for the
guarantor fee (one month's rent, GBP), and emails the tenant the branded payment
email. The `stripe-webhook` function flips Sent to Paid on completion.

## 1. Environment values and where they go

**Client (`opndoor-portal/.env.local`), test publishable key only:**
```
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_xxx
```
Restart the dev server after setting it. This only drives the TEST MODE badge.

**Edge Function secrets (server side, never in the repo).** Set in the Supabase
dashboard: Project > Edge Functions > Secrets (or Project Settings > Edge
Functions). Add:

| Secret | Value | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_xxx` | Required for the New Application flow and the webhook. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_xxx` | From the Stripe webhook endpoint (step 3). |
| `RESEND_API_KEY` | `re_xxx` | Optional. Without it, creation still works and the email is reported as not sent. |
| `EMAIL_REVIEW_ADDRESS` | your email | TEST SAFETY: every tenant email is redirected here. Required for any email to send. |
| `EMAIL_FROM` | `opndoor <payments@opndoor.co>` | Optional; this is the default. |
| `EMAIL_REPLY_TO` | `hello@opndoor.co` | Optional; this is the default. |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically; do not set them. Secrets take effect on the next function call,
no redeploy needed.

> The New Application form will not complete until `STRIPE_SECRET_KEY` is set,
> because the send includes creating the Checkout Session.

## 2. Resend (branded email) and DNS

1. Create a Resend account and an API key; set it as `RESEND_API_KEY`.
2. Add the domain `opndoor.co` in Resend > Domains. Resend shows the exact
   records to add at your DNS provider, usually:
   - DKIM: a `CNAME` (or `TXT`) record, e.g. host `resend._domainkey`.
   - SPF / return-path: a `TXT` record (`v=spf1 include:...`) and often an `MX`
     record on a `send` subdomain.
   - DMARC (recommended): a `TXT` record at `_dmarc`.
   Copy the exact values from the Resend dashboard; they are account specific.
3. Until the domain is verified, Resend only lets you send to your own account
   email, so set `EMAIL_REVIEW_ADDRESS` to that address for now. Once verified,
   sending from `payments@opndoor.co` works and creation emails send
   automatically. If Resend is not configured, the app still creates the
   application and shows the copyable link, and reports the email as not sent.

## 3. Point the Stripe test webhook at the function

Function URL: `https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/stripe-webhook`

**Dashboard (recommended for the deployed function):** Stripe test dashboard >
Developers > Webhooks > Add endpoint > paste the URL. Select events:
`checkout.session.completed`, `charge.refunded`,
`payment_intent.payment_failed`, `checkout.session.expired`. Save, reveal the
Signing secret (`whsec_...`), and set it as `STRIPE_WEBHOOK_SECRET`.

**Or Stripe CLI (local dev):**
```
stripe login
stripe listen --forward-to https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/stripe-webhook
```
The CLI prints a `whsec_...`; set that as `STRIPE_WEBHOOK_SECRET`.

## 4. End-to-end test (test cards)

Make sure the dev server is running (`npm run dev`), you are signed in, and the
env above is set.

1. **Badge:** open any Sent application; the Payment card shows a "Test mode"
   badge and "Awaiting payment" with the copyable checkout link.
2. **Create and send:** New Application, complete it, Send. You are taken to the
   detail page. Check your `EMAIL_REVIEW_ADDRESS` inbox: you receive the branded
   opndoor payment email (tenant name, guarantee reference, amount, Pay button),
   with a banner noting who it was intended for.
3. **Pay (success):** click Pay in the email (or Copy the link on the detail
   page), pay with `4242 4242 4242 4242`, any future expiry, any CVC, any
   postcode. On success Stripe redirects the tenant to the public
   **`/pay/confirmed`** page (payment received, amount, reference; then a
   "Sign your deed now" button once the deed generates). Back in the portal the
   application's detail page shows **Paid** with the date (dd/mm/yyyy), amount
   (GBP) and Stripe reference, and the Paid event appears in the activity feed.
4. **Decline (no change):** create another referral, open its link, pay with
   `4000 0000 0000 0002` (declined). The application stays **Sent / Awaiting
   payment**; no status change.
5. **Duplicate webhook (idempotent):** in Stripe > Webhooks > your endpoint,
   open the delivered `checkout.session.completed` event and click **Resend**.
   The application stays Paid, with no second transition (the event id is
   deduplicated in `stripe_events`, and the transition only fires while Sent).
6. **Refund (recorded, not reversed):** in Stripe, refund the test payment. The
   detail page shows **Refunded** with the refund reference; the status remains
   Paid by design.

## 5. Inspect state directly (optional)

```sql
select guarantee_ref, status, payment_state, paid_at, paid_amount,
       stripe_payment_intent_id, refunded_at, stripe_refund_id
from public.applications
where guarantee_ref = 'GR-XXXXX';

select kind, message, actor, at
from public.activity_log
where application_id = (select id from public.applications where guarantee_ref = 'GR-XXXXX')
order by at desc;
```

## Notes

- Functions: `create-referral` and `resend-payment-email` require a signed-in
  (JWT) caller; `stripe-webhook` has JWT verification off and is secured by the
  Stripe signature instead.
- `apply_stripe_payment` / `apply_stripe_refund` are service-role only (the
  webhook's transition path), separate from the AAL2 + opndoor-admin-only
  `set_application_status` (a manual test/admin utility).
- All source lives in `opndoor-portal/supabase/functions/`. Redeploy after edits
  with `npx supabase functions deploy <name> --project-ref pwftaqtrrqtilxlvwxjd`
  (webhook needs `--no-verify-jwt`).
