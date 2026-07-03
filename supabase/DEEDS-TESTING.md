# Deed of Guarantee (PandaDoc sandbox) - setup and test runbook

Strictly sandbox/test. The Edge Functions only act when `PANDADOC_API_KEY` and
`PANDADOC_TEMPLATE_ID` are set, and every recipient is redirected to
`EMAIL_REVIEW_ADDRESS`, so no real tenant is ever emailed. Do not point this at a
production PandaDoc workspace or a live API key.

Flow: when Stripe flips an application to **Paid**, the `stripe-webhook`
generates the Deed of Guarantee from the PandaDoc template (six merge tokens),
and sends it to the tenant to e-sign. The application stays **Paid** with a
visible deed sub-state (`awaiting_tenant`). When the tenant signs, PandaDoc fires
`document.completed`; the `pandadoc-webhook` (signature-verified, idempotent,
service role) downloads the executed PDF, stores it privately, and flips
**Paid -> Deed Issued**. Download deed serves that PDF via a short-lived signed
URL.

The tenant is the **only** live signer. The opndoor director's signature is a
facsimile image placed as static content in the template under standing
authority; there are no director recipients. The **Issue Date** is the deed's
dated line. PandaDoc date fields are recipient-editable, which is unacceptable on
a legal instrument, so the Issue Date is a **merge token** (`issue_date` = the
generation date, Europe/London, dd/mm/yyyy), not a recipient field. That same
date is written to the application's `issue_date` at generation, so the printed
date and the record always agree; the completion webhook leaves `issue_date`
untouched (`deed_issued_at` is the separate execution timestamp).

## 1. Environment values and where they go

**Client (`opndoor-portal/.env.local`), optional badge only:**
```
VITE_PANDADOC_SANDBOX=true
```
Restart the dev server after setting it. This only shows the "Sandbox" badge on
the deed card; it carries no secret.

**Edge Function secrets (server side, never in the repo).** Set in the Supabase
dashboard: Project > Edge Functions > Secrets. Add:

| Secret | Value | Notes |
|---|---|---|
| `PANDADOC_API_KEY` | sandbox `API-Key` | From the PandaDoc **sandbox** workspace (Settings > API). Sandbox key only. |
| `PANDADOC_TEMPLATE_ID` | template uuid | The Deed of Guarantee template (step 3). Swapping templates is config-only, no code change, as long as the token names and Tenant role match. |
| `PANDADOC_WEBHOOK_SHARED_KEY` | shared secret | The shared key you set on the PandaDoc webhook (step 4). Verifies the signature. |
| `EMAIL_REVIEW_ADDRESS` | mdwyer@opndoor.co | TEST SAFETY: every deed recipient is redirected here. Shared with the payments runbook. |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically; do not set them. Secrets take effect on the next function call, no
redeploy needed.

## 2. What must exist in Supabase (already applied)

- `applications`: `pandadoc_document_id`, `deed_state`
  (`awaiting_tenant | executed | declined | voided | error`), `deed_sent_at`,
  `deed_executed_at`, `executed_pdf_path`.
- `pandadoc_events` (id PK) for webhook idempotency, RLS on.
- Private storage bucket `deeds` (not public).
- Service-role RPCs `apply_deed_executed` (idempotent Paid -> Deed Issued) and
  `set_deed_state`, revoked from public/anon/authenticated.
- Functions deployed: `pandadoc-webhook` (JWT off), `pandadoc-resend` (JWT on),
  `deed-download` (JWT on), plus the `stripe-webhook` change that calls
  `generateDeed` on the Paid transition.

## 3. Build the template in the PandaDoc sandbox

1. Switch to the **sandbox** workspace (top-left workspace switcher; sandbox is
   free and clearly labelled). Everything below is done in sandbox.
2. Templates > New > upload the Deed of Guarantee `.docx`.
3. Add **one** signer role named exactly `Tenant`.
4. Place exactly **one Signature** field for the Tenant role on the signature
   block. Do **not** add a Date field: PandaDoc date fields are recipient-editable
   and must not carry the deed's Issue Date. Put the merge token `[issue_date]` on
   the deed's dated line instead (see the tokens below).
5. Leave the opndoor signature as the **static facsimile image** already in the
   document at "Signed for and on behalf of the Guarantor". Do not add a second
   signer role for it.
6. Define these six **merge tokens** (Manage > Tokens, names exact):
   `reference_number`, `tenant_name`, `tenancy_start_date`, `rental_address`,
   `agent_email`, `issue_date`. The names are the contract that keeps the template
   swappable. `issue_date` is filled server-side with the generation date
   (Europe/London, dd/mm/yyyy); it is not entered by the tenant.
7. Save, then copy the template id from the URL (or Template > ... > Details) and
   set it as `PANDADOC_TEMPLATE_ID`.

> The token names and the `Tenant` role name are the only coupling between the
> template and the code. Keep them exact and you can restyle or re-upload the
> deed without touching the functions.

## 4. Point the PandaDoc webhook at the function

Function URL:
`https://pwftaqtrrqtilxlvwxjd.supabase.co/functions/v1/pandadoc-webhook`

1. PandaDoc sandbox > Settings > Integrations > Webhooks (or Developers >
   Webhooks) > Create.
2. **Endpoint URL:** paste the function URL. The function reads the signature
   from a `signature` query parameter, which PandaDoc appends automatically; you
   do not add it yourself.
3. **Shared key:** set a strong shared secret and copy the same value into the
   `PANDADOC_WEBHOOK_SHARED_KEY` secret. This is what the function HMAC-verifies.
4. **Events:** subscribe to document state change events, at minimum
   `document_state_changed`. The function keys off `data.status` =
   `document.viewed` (records first view), `document.completed` (signed),
   `document.voided` and `document.declined`.
5. Enable PandaDoc's **automatic signer reminders** on the workspace/template so
   unsigned deeds are chased without manual action; the app's manual "Resend
   signature request" is on top of that, not instead of it.

## 5. End-to-end test

Make sure the dev server is running (`npm run dev`), you are signed in, and both
the payments and deeds env above are set.

1. **Reach Paid.** Follow the payments runbook to take a referral to **Paid**
   (`4242 4242 4242 4242`). On the Paid flip the deed generates automatically.
2. **Awaiting signature.** The detail page's Guarantee deed card shows a
   "Sandbox" badge, "Deed sent for signature, awaiting tenant" and the signing
   journey: **Sent** [date/time] then **Not yet viewed**. The activity feed shows
   "Deed of Guarantee sent to the tenant for signature". Your `EMAIL_REVIEW_ADDRESS`
   inbox receives the PandaDoc signing email (redirected from the tenant).
3. **View (not yet signing).** Open the signing link so the document reaches
   `document.viewed`, but do not sign yet. The journey row flips to **Viewed by
   tenant** [date/time], the activity feed gains "Deed viewed by the tenant", and
   the Activity page's Awaiting-signature list shows the **Viewed** date (was "Not
   viewed"). Re-open the link: no second view is recorded (first view only).
4. **Sign.** Complete the Signature field (the only recipient field), finish.
   PandaDoc fires `document.completed`; the activity feed gains "Deed signed by
   the tenant". Confirm the deed's dated line shows the generation date from
   `[issue_date]`, equal to the application's `issue_date` (set at generation).
5. **Deed Issued.** The detail page flips **Paid -> Deed Issued** (the terminal
   milestone; signing is what issues it). The deed card shows the deed file and
   **Download deed** opens the executed PDF via a signed URL; issue and expiry
   dates are populated.
6. **No agent contact (blocked with a clear error).** For a branch with no agent
   contact, generation sets `deed_state = error` and logs "add an agent contact
   for this branch, then retry". The deed card shows the warning and a **Generate
   deed** button; add a contact, click it, and it regenerates.
7. **Decline / void (review, no reversal).** Decline or void the document in
   PandaDoc. The deed card shows the review warning with a **Generate deed**
   button; the status stays Paid. Activity logs the decline/void.
8. **Duplicate webhook (idempotent).** Re-deliver a `document.completed` event
   from PandaDoc. No second transition and no duplicate PDF (the
   `docId:status` key is deduplicated in `pandadoc_events`, and
   `apply_deed_executed` only fires while Paid).
9. **Ageing chase.** An `awaiting_tenant` deed whose `deed_sent_at` is more than
   7 days ago appears on the Activity page under "Awaiting tenant signature",
   longest-waiting first, with a **Viewed / Not viewed** column so partners can
   chase intelligently (never opened is more urgent than opened-not-signed).
10. **Resend after the tenant has opened it.** Open the signing link (so the
   document moves to `document.viewed`), then click **Resend signature request**
   (shown to the owning Referrer, Management and admin). It must succeed with
   "Signature reminder sent to the tenant" (PandaDoc's manual reminder), not an
   error. If the reminder endpoint is unavailable on the plan, it falls back to
   emailing a fresh signing link (needs `RESEND_API_KEY`). A signed/declined/voided
   document returns an honest "cannot remind, use Replace and resend deed" message.
   - **Email fallback unavailable (unverified Resend domain).** When both the
     reminder endpoint and the email fallback fail, the toast and the business
     activity feed show "Reminder could not be sent, email service awaiting
     configuration"; the raw provider error (e.g. Resend 403) is logged
     `internal`, visible to opndoor admin only. No raw error reaches partners.
11. **Replace and resend deed (Management / opndoor admin).** While a deed is
    awaiting signature, click **Replace and resend deed** and confirm ("This
    cancels the deed currently awaiting signature and sends the tenant a new one.
    The old signing link will stop working."). The outstanding document is voided
    (expired) in PandaDoc, `deed_state` and the document id are cleared, and a
    fresh deed is generated and sent; activity logs both the void and the fresh
    send. A Referrer does not see this button and is refused server-side. Confirm
    the old document, if later completed or voided, does NOT flip the application
    to Deed Issued (its id no longer matches any row, so the webhook is inert).

## 6. Email identity and copy

The signing email is sent by PandaDoc's own mail service (not Resend, so it is
not governed by `EMAIL_FROM`). Two parts:

- **Subject and body copy** are set explicitly in code (`createAndSend` /
  `resendDocument` in `_shared/pandadoc.ts`): subject "Your opndoor Deed of
  Guarantee, [reference]" and a short opndoor-branded confirmation message. Edit
  those strings and redeploy to change the wording.
- **Sender display name** ("X sent you ...") is NOT settable per document by the
  API. PandaDoc uses the profile name of the workspace member whose API key sent
  the document, which is why it currently reads a personal name. To make it read
  "opndoor", change it at the account level, either:
  - rename that member: PandaDoc > Settings > (top-right avatar) My Profile /
    Account > set the First/Last name to "opndoor"; or, cleaner,
  - create a dedicated workspace member named "opndoor" (Settings > Team /
    Members > invite), generate an API key under that member, and set it as the
    `PANDADOC_API_KEY` secret.
  Company logo and colours in the email are separate, under Settings > Branding.
  The `[DEV]` prefix is the sandbox watermark and disappears in production.

## 7. Inspect state directly (optional)

```sql
select guarantee_ref, status, deed_state, deed_sent_at, deed_executed_at,
       pandadoc_document_id, executed_pdf_path
from public.applications
where guarantee_ref = 'GR-XXXXX';

select id, type, application_id, received_at
from public.pandadoc_events
order by received_at desc
limit 20;
```

## Notes

- `pandadoc-webhook` has JWT verification off and is secured by the PandaDoc HMAC
  signature instead; `pandadoc-resend`, `deed-download` and
  `pandadoc-void-regenerate` require a signed-in (JWT) caller and are scoped by
  RLS to whoever can already see the application (owning Referrer, Management,
  admin). `pandadoc-void-regenerate` additionally refuses anyone who is not
  Management or opndoor admin (checked against `users.role`).
- Resend is state-aware (`remindSignature` in `_shared/pandadoc.ts`): it reads the
  document status first, uses PandaDoc's manual reminder
  (`POST /documents/{id}/send-reminder`, valid in sent + viewed) rather than
  re-`send` (which 403s once viewed), and falls back to emailing a fresh signing
  session link. Void uses `PATCH /documents/{id}/status` to Expired (11), the
  API's cancel path (there is no "voided" verb).
- Zombie-safety: `apply_deed_executed` and `set_deed_state` both match on
  `pandadoc_document_id`. Void-and-regenerate clears that id before regenerating,
  so any later event for the superseded document matches no row and cannot flip
  the application to Deed Issued.
- Signing journey: `document.viewed` records `deed_viewed_at` once (first view;
  reset to null on each (re)generation) and logs "Deed viewed by the tenant".
  `document.completed` logs "Deed signed by the tenant" - the signing event,
  distinct from the "Deed Issued" milestone (status/timeline), which signing
  drives. There is no separate issued-vs-signed milestone; Deed Issued stays the
  terminal state. The deed card shows Sent -> Viewed/Not-yet-viewed while awaiting;
  the Awaiting-signature chase list carries the same Viewed column.
- Activity visibility: `activity_log.visibility` is `business` or `internal`. Raw
  technical failures (`deed_error`, `payment_email_failed` - PandaDoc/Resend API
  text) are inserted `internal` and shown only to opndoor admin (`superadmin`).
  Referrers and Management see business events only; when a deed is currently
  stuck (`deed_state = error`) they instead see a soft "Deed delivery delayed,
  opndoor has been notified" entry. The detail-page feed is sourced solely from
  `activity_log` (one row per event, real `dd/mm/yyyy · HH:mm` timestamp); the
  status timeline strip is separate.
- `apply_deed_executed` / `set_deed_state` are service-role only (the webhook's
  transition path), the deed twins of `apply_stripe_payment`.
- All source lives in `opndoor-portal/supabase/functions/`. Redeploy after edits
  with `npx supabase functions deploy <name> --project-ref pwftaqtrrqtilxlvwxjd`
  (`pandadoc-webhook` needs `--no-verify-jwt`).
