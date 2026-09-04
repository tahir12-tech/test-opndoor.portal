# HANDOVER-MACHINE.md

Engineering handover for the **opndoor Guarantee Referral Portal**.

Written for **Balal**, picking this up the morning after the closing batch. You have
~7 working days to production; **go-live is Wednesday 15 July 2026**. This document is
everything I know that the repo alone doesn't tell you — the operational estate, the
deliberate deferrals, the gotchas that cost time this week, and the exact steps to
stand up a fresh production project. It is deliberately thorough over polite. Read the
"First ten minutes" section, then skim the rest, then keep it open while you work.

Tag at handover: **`v1.0-handover`** on `main` (commit `4c6b105`). The exit gate was
green: typecheck, build, 125/125 tests, and the C1–C8 database security proofs.

---

## 0. First ten minutes (read this before touching anything)

1. **The repo root is `opndoor-portal/`, not the workspace root.** The workspace root
   (`opndoor-new-platform/`) holds `.mcp.json` (MCP config, carries a HubSpot token in
   plaintext) and is *not* the git repo. `git` lives in `opndoor-portal/`.
2. **This is a real money path against real integrations.** Stripe, PandaDoc, Resend
   and HubSpot are all wired to a live Supabase project (`pwftaqtrrqtilxlvwxjd`). The
   demo/test data lives under one isolated partner (`@brackenhouse.co.uk`). Do not test
   against live partner rows — see §5 (test-fixture rule).
3. **The database is the source of truth for commission economics — and "source of
   truth" means the STORED value, not the displayed one.** A display that rounds or
   formats can hide a wrong stored number. Verify the column, not the screen. (This
   doctrine came from a real incident this week; §5.)
4. **Two data modes.** The React app runs in mock/localStorage mode OR live Supabase
   mode, toggled by `SUPABASE_ENABLED` (`src/lib/supabase.ts`). Most unit tests and the
   demo run mock; production is live. Many services branch on `SUPABASE_ENABLED` or
   `liveAvailable()`. When something "works in the demo but not live" (or vice versa),
   this branch is usually why.
5. **RLS is the security boundary, not the client.** Every table is row-level-secured
   and gated on AAL2 (2FA). The client's role checks are UX; the database enforces
   access. Proven in `supabase/SECURITY-PROOF.md` (C1–C8). If you change a policy,
   re-run those proofs.
6. **Deploying an edge function resets `verify_jwt` unless you pass it explicitly.**
   This bit us. Webhooks (`stripe-webhook`, `pandadoc-webhook`, `hubspot-sync`,
   `payment-page`, the cron-driven functions) MUST stay `verify_jwt=false`; they do
   their own auth. Always pass `verify_jwt` on every deploy. See §2 and §5.
7. **The HubSpot integration is pointed at a SANDBOX that expires imminently.** The
   `hubspot-sync` cron runs every 2 minutes. If the sandbox lapses, you'll get
   `hubspot_sync_error` ops-alerts every couple of minutes. Pause that cron on the demo
   before the sandbox dies (§6), or promote to production (§6 promotion checklist).
8. **`diag-genlink` is a diagnostic function** (magic-link generator for debugging).
   Confirm it should not ship to production and remove it if not.

The canonical written specs already in the repo — read these next:
`README.md`, `supabase/README.md`, `supabase/SECURITY-PROOF.md`, `HUBSPOT-SYNC-SPEC.md`,
`VERIFICATION-SCRIPT.md`, and the per-subsystem docs under `supabase/` (`DEEDS-TESTING`,
`PAYMENTS-TESTING`, `PAYMENT-REMINDERS`, `EXPIRY-REMINDERS`, `EXPIRY-COHORTS`,
`WEEKLY-DIGEST`).

---

## 1. System map — every subsystem

Frontend is React + Vite + TypeScript (SPA). Data layer under `src/data/` (services),
`src/lib/` (supabase client, hydration), `src/session/` (auth/session). Backend is
Supabase: Postgres + RLS, Edge Functions (Deno), pg_cron + pg_net, Supabase Auth.

| Subsystem | What it does | Where it lives | Trigger |
|---|---|---|---|
| **Auth / TOTP (2FA)** | Email+password then a 6-digit TOTP; AAL2 required everywhere. First login enrols an authenticator. | `src/session/SessionContext.tsx`, Supabase Auth, `is_aal2()`/`is_admin()`/`app_role()`/`app_partner()` SQL helpers | User sign-in |
| **Referrals** | The new-application form (Tenant → Property → Tenancy → Agent & branch), fly-creation of agencies/branches, submission. | `src/pages/NewApplication/`, `src/components/AgentBranchPicker.tsx`, `create-referral` edge fn, `create_referral` RPC | User submits |
| **Payments + Stripe** | Tenant pays one month's rent via Stripe Checkout; webhook applies the payment. | `payment-page` (public pay page), `payment-confirmation`, `stripe-webhook` → `apply_stripe_payment` RPC | Tenant pays / Stripe event |
| **Deeds + PandaDoc** | Generates the Deed of Guarantee, sends for e-sign, tracks state (awaiting → viewed → signed → issued). | `pandadoc-*` edge fns, `pandadoc-webhook` → `apply_deed_executed`/`set_deed_state`, `_shared/pandadoc.ts` | Deed lifecycle events |
| **Deed delivery** | Sends the issued deed to the agent's primary contact; flags "delivery failed" if none. | `send-deed-to-agent` (+ `send_deed_to_agent` RPC), `deed-download` | Admin/mgmt action |
| **Payment reminders** | Chases unpaid referrals on a schedule. | `payment-reminders` edge fn; `supabase/PAYMENT-REMINDERS.md` | pg_cron 07:00 & 08:00 |
| **Expiry reminders** | Warns before a guarantee expires (tenancy start + 12m − 1d). | `expiry-reminders`, `expiry-cohorts` (cohort helper); `EXPIRY-REMINDERS.md`, `EXPIRY-COHORTS.md` | pg_cron 07:00 & 08:00 |
| **Auto-expiry** | Marks a Sent-but-unpaid referral Expired after 14 days (terminal). | expiry logic in the reminder/cohort path + status rules | Cron / status derivation |
| **Withdrawal / tenant-decline** | Withdraw at Sent (terminal, pre-payment); tenant can decline. | `src/pages/ApplicationDetail/`, status rules; `tenancy-correction` for corrections | Admin/mgmt/tenant |
| **Weekly digest** | Monday summary email to stakeholders. | `weekly-digest` edge fn; `WEEKLY-DIGEST.md` | pg_cron Mon 07:00 & 08:00 |
| **League + snapshots** | Ranks agencies/branches/referrers by period. Commission figures read SNAPSHOTTED rates (rate-snapshot law). | `src/pages/League/`, `src/data/leagueService.ts`, `analyticsService.ts` | UI |
| **Settlements** | Prior calendar month, net of refunds, payable the 15th; one figure per partner. | `getCommissionSettlement` in `src/data/liveAnalytics.ts`; `src/data/exportsService.ts` | UI / export |
| **Bordereau** | Underwriter's monthly premium schedule (xlsx, verbatim to their template). Superadmin only. | `buildLiveBordereau`/`exportBordereauFile` (`exportsService.ts`), `buildBordereauWorkbook` (`xlsxTemplate.ts`) | Dashboard export |
| **Notes** | Per-application internal notes. | application detail + service layer | UI |
| **Ops alerting** | Central incident channel: `report_ops_incident(type, detail)` → `ops-alert` edge fn → email. | `ops-alert` edge fn, `report_ops_incident` RPC | Any failure path |
| **Health** | Operational status view for integrations/jobs. | `src/pages/` Health screen | UI |
| **Reconciliation** | Queue of fly-created agencies/branches; confirm/merge; single-office head-office folds into the agency card; confirm nudges a HubSpot sync. | `src/pages/Reconciliation/`, `reconciliationService.ts`, `reconciliation_queue`/`confirm_org_entity` RPCs | UI |
| **HubSpot sync** | One-way, event-driven Portal→HubSpot. Consumes `activity_log` from a cursor, upserts Applicants + Companies + associations. Config-not-code. | `hubspot-sync` edge fn, `hubspot_sync_env`/`hubspot_field_map`/`hubspot_partner_map`, `HUBSPOT-SYNC-SPEC.md` | pg_cron every 2 min + confirm nudge + Sync button |
| **Help / guides** | Help page: role-specific guides, shareable PDFs, FAQs, account managers. | `src/pages/Help/`, `src/data/helpService.ts`, `src/data/mock/help.ts`, `public/help-docs/` | UI |

---

## 2. The operational estate

### 2.1 Edge functions (21 active) and their auth model

Note: 20 of these have source under `supabase/functions/`; **`diag-genlink` is deployed
but is NOT in the repo** — one more reason to confirm and remove it before go-live.

Deployed to project `pwftaqtrrqtilxlvwxjd`. **Auth model matters** — a webhook/cron
function must be `verify_jwt=false` (it authenticates itself); a user-facing function is
`verify_jwt=true` (Supabase checks the caller's JWT before the body runs).

| Function | Ver | verify_jwt | Auth model |
|---|---|---|---|
| `stripe-webhook` | 32 | **false** | Stripe signature (`STRIPE_WEBHOOK_SECRET`) |
| `create-referral` | 27 | true | User JWT; RLS + field rules apply as caller |
| `resend-payment-email` | 23 | true | User JWT |
| `pandadoc-webhook` | 22 | **false** | PandaDoc webhook (shared secret / signature) |
| `pandadoc-resend` | 20 | true | User JWT |
| `deed-download` | 12 | true | User JWT (ownership/role) |
| `pandadoc-void-regenerate` | 10 | true | User JWT |
| `amend-tenancy-start` | 11 | true | User JWT → `amend_tenancy_start` RPC (AAL2 + role + `can_amend_tenancy_start`) |
| `expiry-reminders` | 12 | **false** | `x-ops-secret` (cron secret) |
| `payment-confirmation` | 6 | **false** | Post-Stripe redirect confirmation |
| `send-deed-to-agent` | 7 | true | User JWT → `send_deed_to_agent` RPC (referrers can't set a recipient) |
| `send-password-reset` | 5 | **false** | Public (rate-limited) password-reset trigger |
| `invite-user` | 5 | true | User JWT (admin/management) |
| `diag-genlink` | 3 | true | **Diagnostic — confirm & remove for prod** |
| `tenancy-correction` | 3 | **false** | Internal correction path |
| `expiry-cohorts` | 5 | **false** | `x-ops-secret` (cron helper) |
| `payment-reminders` | 8 | **false** | `x-ops-secret` (cron secret) |
| `ops-alert` | 5 | **false** | `x-ops-secret` |
| `weekly-digest` | 4 | **false** | `x-ops-secret` (cron secret) |
| `payment-page` | 4 | **false** | Public tenant payment page |
| `hubspot-sync` | 5 | **false** | `x-ops-secret` matched vs `REMINDERS_CRON_SECRET` (edge) OR `ops_secrets.reminders_cron`; HubSpot token via `HUBSPOT_ACCESS_TOKEN` edge env → `x-hubspot-token` header → `ops_secrets.hubspot_access_token` |

RPC-gated privileged writes (service-role only; `authenticated` revoked):
`apply_stripe_payment`, `apply_stripe_refund`, `apply_deed_executed`, `set_deed_state`,
`fire_expiry_reminders`. See `SECURITY-PROOF.md` Part D for the full definer-function audit.

### 2.2 pg_cron jobs (8, all active)

Schedules are **UTC**. Reminder/digest jobs fire twice (07:00 and 08:00) to cover the
GMT/BST hour shift; the functions are idempotent per day, so the second fire is a no-op
if the first already ran. Each cron uses `net.http_post` (pg_net) to call the edge
function with the `x-ops-secret` header read from `ops_secrets` **inside SQL**.

| jobid | name | schedule | what |
|---|---|---|---|
| 1 | `expiry-reminders-0700` | `0 7 * * *` | expiry reminders |
| 2 | `expiry-reminders-0800` | `0 8 * * *` | expiry reminders (BST cover) |
| 3 | `rate-limit-cleanup` | `7 * * * *` | `delete from public.rate_limit where window_start < now() - interval '1 hour'` |
| 4 | `payment-reminders-0700` | `0 7 * * *` | payment reminders |
| 5 | `payment-reminders-0800` | `0 8 * * *` | payment reminders (BST cover) |
| 6 | `weekly-digest-0700` | `0 7 * * 1` | Monday digest |
| 7 | `weekly-digest-0800` | `0 8 * * 1` | Monday digest (BST cover) |
| 8 | `hubspot-sync` | `*/2 * * * *` | HubSpot sync (**pause on demo if the sandbox expires**) |

To pause the HubSpot cron: `update cron.job set active=false where jobname='hubspot-sync';`
(or `select cron.unschedule('hubspot-sync');`).

### 2.3 Secrets — where each lives and WHY

Three homes, by necessity:

- **Edge function secrets** (Supabase "Edge Function Secrets" / project env): the real
  credentials the function code reads via `Deno.env.get(...)`. Known set:
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REMINDERS_CRON_SECRET`, `APP_URL`
  (a.k.a. base URL), `HUBSPOT_ACCESS_TOKEN`, plus Stripe (`STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`), PandaDoc (`PANDADOC_API_KEY` + webhook secret), Resend
  (`RESEND_API_KEY`). Verify the exact names in each function before a fresh deploy.
- **`public.ops_secrets` table** (the mirror): currently one row, `reminders_cron`.
  **Why the mirror exists:** the pg_cron jobs call edge functions from *inside SQL* via
  pg_net, and SQL **cannot read edge-function env vars**. So the cron secret is mirrored
  into a table that SQL can read, and the cron sets `x-ops-secret` from it. The edge
  function accepts EITHER its `REMINDERS_CRON_SECRET` env OR the `ops_secrets` mirror —
  which is exactly why they must be kept identical (see the "cron 401 drift" gotcha, §5).
  The HubSpot token is NOT mirrored here (there's no cron-SQL reason to); it lives in the
  edge env / header.
- **Supabase Vault**: for any secret referenced by SQL/pg_net that shouldn't be a plain
  table value. Check `vault.secrets` on the fresh project during promotion.

`.mcp.json` (workspace root) holds a **HubSpot private-app access token in plaintext**
for local MCP tooling — gitignored, never committed. Treat it as a live credential.

### 2.4 Webhooks and idempotency

- **Stripe** → `stripe-webhook` (verify_jwt=false, signature-verified). Idempotent via
  the `stripe_events` ledger (RLS-on, no policy: service-role only, append-only). A
  replayed event is a no-op.
- **PandaDoc** → `pandadoc-webhook` (verify_jwt=false). Idempotent via `pandadoc_events`
  ledger (same deny-all pattern). Event→state mapping in `_shared/pandadoc.ts`
  (e.g. `document.completed` → "already signed").
- **HubSpot** is outbound only (no inbound webhook). Idempotency is the
  `hubspot_sync_events` ledger keyed on `${event_id}:applicant` and
  `assoc:${app_id}:partner|branch`; every HubSpot write is idempotent by construction
  (upsert on a unique property; PUT association). The cursor (`hubspot_sync_cursor`)
  holds at the last success so a failed batch retries safely.

### 2.5 MCP setup

`.mcp.json` (workspace root, `opndoor-new-platform/.mcp.json`, 508 bytes, gitignored).
Two servers configured: **supabase** and **hubspot**. (A Google Drive MCP server is also
available in the Claude session but is not in `.mcp.json`; it's interactively
authenticated and absent in headless/cron runs.) The HubSpot MCP token is a private-app
token scoped to the sandbox portal. Supabase MCP talks to project `pwftaqtrrqtilxlvwxjd`.

---

## 3. Known limitations, deliberate deferrals, v1 caveats

Documented, on-purpose, or accepted for v1 — none are surprises, all are here so you
don't re-discover them the hard way.

- **HubSpot sync — watermark edge.** The cursor is `(last_at, last_id)`. Events sharing
  an identical timestamp are ordered by id; the tuple handles it, but a very large
  same-timestamp burst is the theoretical edge. See `HUBSPOT-SYNC-SPEC.md`.
- **HubSpot sync — datetime→midnight transform.** HubSpot date-picker properties want
  midnight-UTC epoch ms; `midnightMs()` does `Date.parse(dateOnly + "T00:00:00Z")`. Dates
  near a timezone boundary rely on this being UTC-anchored. Deliberate.
- **HubSpot sync — `delivered_to` derivation.** Derived from the primary agent contact
  (branch first, then agency fallback); null when no contact exists. Not authoritative
  delivery proof, just the best-known recipient.
- **HubSpot sync — reinstatement not synced.** Un-withdrawing / un-refunding an
  application is not modelled as a distinct sync event. If you reinstate, reconcile in
  HubSpot by hand.
- **HubSpot — dormant `partner_commission_rate` row.** `hubspot_field_map` has an
  Applicant `partner_commission_rate` row shipped `active=false` (source `partner_rate`,
  transform `number`). The property does not exist on the Applicant object yet and the
  sandbox token lacks schema-write scope. Create the property at production promotion,
  then flip the row active (§6). The **company** `commission_rate` row IS active (that
  property already exists on Companies).
- **Hydration row-cap.** The client hydrates a bounded set of rows from Supabase
  (see `src/lib/hydrate.ts`). A very large production estate can exceed the cap; live
  analytics/list views would then see a truncated set. Revisit paging before scale.
- **Gated Help guides are card-hidden but URL-reachable.** `management-guide.html` and
  `opndoor-admin-guide.html` under `public/help-docs/` are static files served at
  guessable URLs; `minRole` only hides the Help *card*. Content is non-sensitive
  documentation and all enforcement is server-side, so this was **accepted** for v1
  (VERIFICATION-SCRIPT findings log, row 1). Post-launch hardening: serve the two gated
  guides through an auth-checked SPA route instead of static files.
- **Mock-mode League drill-through sparseness.** In demo/mock mode the synthetic League
  referrer names don't all match the seed application referrers, so a League→Applications
  `?referrer=` click can land on an empty list. Fully consistent in live mode (both come
  from `referrer_name`). Cosmetic, demo-only.
- **Bordereau formatting vs the raw template.** The real underwriter template stores bare
  numbers (rate `0.125`, premium `109.375`). We keep light `£`/percent formatting on the
  money columns per the spec's "£ amount" wording; structure (headers, merges A1:N1,
  column order, "On Cover") is verbatim. If the underwriter insists on bare numbers, drop
  the `z` formats in `buildBordereauWorkbook`.
- **`diag-genlink`** exists in production project space — a debugging magic-link
  generator. Decide and remove before go-live if it shouldn't ship.

---

## 4. Money-path invariants (read before touching any figure)

Four rules hold everywhere money is computed. Break one and you'll rewrite history
silently — there's no exception path.

1. **Source of truth is the STORED value.** The portal DB is authoritative for
   commission economics; a display that rounds/formats can mask a wrong stored number.
   Audit the column, not the screen.
2. **Rate-snapshot law.** Every League/settlement/export/commission figure reads the
   rates snapshotted onto the application at creation (`applications.partner_rate` /
   `agent_rate`), never the partner's live rate. Editing a partner's rate moves future
   referrals only.
3. **The fee is one month's rent; partner earns 25%, agent 10%** — visible to management
   and opndoor admin only, never to referrers (exports strip it).
4. **Money writes are service-role RPCs behind idempotent ledgers.** `apply_stripe_*`,
   `apply_deed_executed`, `set_deed_state`, `fire_expiry_reminders` are service-role
   only; Stripe/PandaDoc replays are absorbed by the `stripe_events`/`pandadoc_events`
   ledgers. Never write a payment/deed state from the client.

---

## 5. Gotchas that cost us time this week — each with its lesson

- **Auth factor-collision (empty friendly name).** Enrolling a TOTP factor with an empty
  `friendly_name` collided on `auth.mfa_factors`' uniqueness and failed enrolment.
  **Lesson:** always give an MFA factor a non-empty friendly name. (When staging test
  factors in SQL, set `friendly_name` to a real string — the C8 proof uses `'PROOF'`.)
- **Cron 401 drift.** The cron secret in `ops_secrets.reminders_cron` drifted from the
  edge env `REMINDERS_CRON_SECRET`, so cron→function calls started returning 401 and
  reminders silently stopped. **Lesson:** these two must be identical; the function
  accepts either, so a mismatch on one side still "works" until the other is the one
  used. When you rotate the cron secret, rotate BOTH.
- **`verify_jwt` deploy drift.** Redeploying a webhook/cron function without passing
  `verify_jwt` flipped it back to the default `true`, and the function started rejecting
  its (JWT-less) caller. **Lesson:** ALWAYS pass `verify_jwt` explicitly on every deploy.
  The false-list is in §2.1 — memorise it.
- **Rate display-rounding masked a wrong stored value.** A commission rate *displayed*
  correctly (rounded) while the *stored* value was wrong — the UI hid the defect. Fixed
  in `0f28567` (rates display to one decimal, never rounded). **Doctrine:** the portal DB
  is the source of truth for commission economics, and *source of truth means the STORED
  value, not the displayed one*. When auditing money, query the column.
- **External file-revert / drop-in incident.** Source files changed underneath me
  mid-session (the owner dropped the real branded PDFs + the bordereau template into the
  repo root at 19:03–19:06; earlier a file was reverted externally). I'd authored HTML
  from scratch without seeing them. **Lesson:** check `git status` and the actual files
  before assuming the working tree is what you last left; surface external changes rather
  than plough on. (The #110 rework in `d56d9c4` is the correction: serve the real PDFs,
  author three role guides matching their brand.)
- **Test-fixture rule.** Every test user/entity lives under the isolated
  `@brackenhouse.co.uk` partner. **Never** create test rows against a live partner, and
  never delete/mutate a live partner's rows to test. The C-proofs and the C8 MFA-reset
  verification all impersonate brackenhouse users and roll back.
- **Machine-attributed audit rows.** The rate-correction audit rows and any MFA-reset
  audit attributed to **Maya Holloway** were machine-executed, owner-approved corrections
  (I impersonated the superadmin JWT to run them). Maya did not click those by hand —
  don't read them as human activity.

---

## 6. Environment truths

### 6.1 Config vs code

The design principle throughout is **config-not-code**: HubSpot object/pipeline/stage/
association ids, field mappings and partner mappings live in tables
(`hubspot_sync_env`, `hubspot_field_map`, `hubspot_partner_map`), never hard-coded.
Promotion is a config swap, not a redeploy. Similarly, rates are snapshotted onto
applications at creation, so a rate row is data, not code. When something integration-
specific needs changing, look for a table row first.

### 6.2 Demo/production split

Today: one live Supabase project runs both the demo (brackenhouse partner + seed data)
and the real integrations, with HubSpot pointed at a **sandbox** portal
(`hubspot_sync_env.env='sandbox'` is active). The production plan is a clean project (or
a clean cut-over) with the demo data torn down (§7 census) and HubSpot pointed at the
production portal (`env='production'` flipped active).

### 6.3 Production-parity checklist (everything hand-configured a fresh project must recreate)

None of this comes from `supabase db push` — it was all configured by hand and must be
recreated on any fresh project:

- [ ] **Edge function secrets** (§2.3): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
      `REMINDERS_CRON_SECRET`, `APP_URL`/base URL, `HUBSPOT_ACCESS_TOKEN`, Stripe
      (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`), PandaDoc (`PANDADOC_API_KEY` +
      webhook secret), Resend (`RESEND_API_KEY`).
- [ ] **`ops_secrets.reminders_cron`** row set to match `REMINDERS_CRON_SECRET` exactly.
- [ ] **pg_cron jobs** (§2.2) recreated with the project's URL in each `net.http_post`.
      (They reference `https://pwftaqtrrqtilxlvwxjd.supabase.co/...` today.)
- [ ] **Supabase Auth URL config**: Site URL + redirect allow-list for the real app
      domain; email templates; TOTP/MFA enabled.
- [ ] **Stripe**: live keys, and a **webhook endpoint** pointing at the project's
      `stripe-webhook` URL with the matching signing secret.
- [ ] **PandaDoc**: API key, template ids, and a **webhook endpoint** → `pandadoc-webhook`.
- [ ] **Resend**: API key + verified sending domain.
- [ ] **Storage buckets**: the deed storage bucket(s) `deed-download` reads from.
- [ ] **Base URL env** (`APP_URL`) set to the production app domain (used in emails and
      deed links).
- [ ] Deploy every edge function **with `verify_jwt` set per §2.1** (do not accept the
      default). Remove `diag-genlink` if it shouldn't ship.
- [ ] Re-run the C1–C8 proofs against the fresh project (SECURITY-PROOF.md).

### 6.4 HubSpot promotion checklist

To cut HubSpot from sandbox to production:

- [ ] **Flip the config block**: in `hubspot_sync_env`, set `env='production'` active and
      `env='sandbox'` inactive. NOTE: the production row currently has
      `company_branch_type_id = NULL` — **set it** to the real production branch
      association type id first, or branch associations will break.
- [ ] **Create the Applicant `partner_commission_rate` property** in the production Hub,
      then flip the dormant `hubspot_field_map` row (`object='applicant',
      hs_property='partner_commission_rate'`) to `active=true`.
- [ ] **Workflow E association-type pin**: confirm Workflow E reads the PRIMARY
      (partner) company association — the sync makes the partner edge primary and the
      branch edge typed. Pin the association type ids Workflow E depends on.
- [ ] **Hub currency = GBP** (commission/premium figures assume GBP).
- [ ] **Parent-company panel** enabled on the branch company record layout (so the
      branch→parent rollup is visible).
- [ ] **Rightmove company card**: set Commission Rate = **25** by hand (the partner-level
      figure that isn't synced from the portal).
- [ ] **Association labels vocabulary**: align the Hub's association labels to the
      spec's vocabulary (`HUBSPOT-SYNC-SPEC.md`).
- [ ] Verify the production `HUBSPOT_ACCESS_TOKEN` (edge env) has schema-write scope if
      you're creating the property via API rather than in the UI.

### 6.5 The sandbox expiry warning (again, because it will page you)

The HubSpot sandbox trial expires imminently and the `hubspot-sync` cron runs every 2
minutes. When the sandbox lapses, every run fails and fires
`report_ops_incident('hubspot_sync_error', …)` → `ops-alert` email, every 2 minutes.
**Before that happens**, either promote (§6.4) or pause the cron:
`update cron.job set active=false where jobname='hubspot-sync';`

---

## 7. Testing

### 7.1 The 125 automated tests (Vitest) — what they cover

`npm run smoke` (or `npm test`). 15 files under `src/`:

- `applications-filters.test.ts` — status/refunded chips, counts stay honest, **the new
  referrer filter + period recount** (owner addition), honest not-found detail.
- `applications-sort.test.ts` — deterministic sort (newest/oldest/rent), tie-break by ref.
- `settlement-bordereau.test.ts` — settlement (prior month, net of refunds, 15th) and
  `buildLiveBordereau` rows (18-col template order, Landlord=agency, DOB always
  populated, Insurance = rent×rate £, "On Cover").
- `liveAnalytics.test.ts`, `liveAnalytics-identity.test.ts` — live funnel/awaiting math,
  identity/role labelling (superadmin → "opndoor").
- `commission-reporting.test.ts` — commission economics off snapshotted rates.
- `referrer-exclusion.test.ts` — referrer-tier exports strip commission.
- `exports.test.ts` — export document shapes.
- `deed-actions.test.ts` — `canAmendTenancyStart`/`canSendDeed` permission predicates.
- `detail.test.ts` — detail builder, expiry (tenancy start + 12m − 1d).
- `expiry.test.ts` — the single expiry rule.
- `activity.test.ts` — activity feed tiering.
- `format.test.ts`, `browserSession.test.ts` — formatting + session helpers.

**What they DON'T cover:** RLS/permission enforcement (that's the SQL C-proofs, not
Vitest — the mock layer can't exercise Postgres policies); the edge functions and
webhooks (no integration harness — validated by the manual walk); the actual HubSpot/
Stripe/PandaDoc round-trips; and the static-file gating behaviour of the Help guides.
The unit tests run in **mock mode**; they don't prove the live Supabase paths.

### 7.2 VERIFICATION-SCRIPT.md — how to run it

- **§8 (Database security proofs)** is the automated portion — the C1–C8 SQL proofs, run
  in the SQL editor (or via the Supabase MCP), each in `begin; … rollback;`. Re-run these
  after any policy/RPC change. They're the authoritative security layer.
- **§§1–7 and §9 are manual click-walks** for a human (sign-in/MFA, permission matrix,
  deed lifecycle, money path, analytics/exports, reminders, activity tiering, cross-
  partner probes). "**Walked**" this week meant a human actually clicked each step in the
  live app as each role and logged findings in the §Findings log.

### 7.3 What C1–C8 each prove

- **C1** Referrer isolation — a referrer sees only their own referrals.
- **C2** MFA gate — a password-only (AAL1) session sees nothing.
- **C3** Management scoping — management sees its whole partner, not others.
- **C4** Cross-partner — a referrer at one partner cannot reach another partner's rows.
- **C5** opndoor admin — superadmin sees everything.
- **C6** Amend/send permission rules in the DB (`can_amend_tenancy_start`/`can_send_deed`).
- **C7** Referrers cannot write `agent_contacts`.
- **C8** (added this batch) Authenticator-reset scope: AAL2 required; opndoor admin for
  anyone, OR management for a non-superadmin at their own partner; never cross-partner,
  never on opndoor staff; factors + sessions deleted; `reset_mfa` audited.

All C1–C8 were re-run green at the exit gate on the final tree.

---

## 8. Teardown census (demo data to remove before/at production)

All test humans are under **`@brackenhouse.co.uk`** (the isolated demo partner):
- superadmin: **Maya Holloway**
- management: Eleanor Voss, Greg Mason, Owen Black, Rachel Adeyemi, Tom Sefton
- referrers: Aisha Khan, Daniel Wright, Hannah Pryce, James Okafor, Marcus Lin,
  Naomi Clarke, Oliver Grant, Priya Nair, Ruth Findlay, Sophie Bennett

**Walk-test applications** (created during this week's live walks):

| Ref | Status | Payment | Agency / Branch | Tenant |
|---|---|---|---|---|
| GR-20616 | deed | paid | Flycreate Ltd / **Fly Branch** | Matthew Dwyer |
| GR-20617 | withdrawn | awaiting | PRIYA TEST LETTINGS / …Head office | Matthew Dwyer |
| GR-20620 | deed | paid | Final Walk Lettings / …Head office | Walk Test-One |
| GR-20621 | withdrawn | awaiting | Foxglove Residential / Chelsea | Walk Test-Two |
| GR-20622 | **paid** | paid | Foxglove Residential / Fulham | Walk Test-Three |
| GR-20623 | withdrawn | awaiting | NEW WALK / Mayfair | Walk Test-Four |

- **GR-20622 is a live paid state** (money path exercised). If you tear down, reconcile
  Stripe accordingly — don't just delete a paid row.
- **`]` county debris:** `GR-20622.prop_county = "]"` (a stray bracket typed during a
  walk; address is "10 Test Street, London, EC1A 1AA"). Fix or delete with the row.

**Fly-created / test agencies** (all `review_state='confirmed'`): Final Walk Lettings,
Flycreate Ltd, NEW WALK, Persistence Test, PRIYA TEST LETTINGS. **Test branches:**
Final Walk Lettings/Head office, Mayfair, PRIYA TEST LETTINGS/Head office, Fly Branch.
(No orgs remain in `reconciliation_queue` — the queue is empty.)

**Demo config to swap at production:** `hubspot_sync_env` active row (sandbox→production,
§6.4); the seed Help content is regenerated from `src/data/mock/help.ts` (storage key
`grp_help_v9`) — no live-data teardown needed there; `help-docs-src/` holds the
deprecated user-guide PDF and the underwriter template as historical references (not
served).

**Audit-row note (repeat, important):** rate-correction and MFA-reset audit rows
attributed to **Maya Holloway** were machine-executed, owner-approved corrections — not
human clicks.

---

## 9. Things I'd tell you in person that aren't written anywhere else

- **When live ≠ demo, check `SUPABASE_ENABLED` / `liveAvailable()` first.** Half the
  "bugs" that look like logic errors are just the mock-vs-live branch. `allFull()` is
  empty in mock mode (only `hydrate.ts` populates it in live), so live-only analytics
  (settlement, bordereau) show nothing in the demo — that's expected.
- **The rate-snapshot law is load-bearing across every money surface.** League,
  settlement, exports and commission all read `applications.partner_rate`/`agent_rate`
  (snapshotted at creation), never the partner's current rate. If you "fix" a figure by
  reading the live partner rate, you'll silently rewrite history. Don't.
- **`partners` and `applications` carry PER-COLUMN grants, so a new column is invisible
  until you re-grant it.** Commission rates are confidential (a Referrer must never see
  what opndoor pays their partner), and RLS cannot hide a column — so `authenticated`
  holds a column-list grant on those two tables that excludes
  `partner_rate`/`agent_rate`, and the rates reach the client through the
  `partner_commission_rates` / `application_commission_rates` views instead (migrations
  `20260904120000` = views + RPC masking, `20260904120500` = the column cut-over, split
  so the front end can deploy between them; proof C9). If you `alter table … add column` on either table, end the
  migration with `select public.reapply_rate_column_privileges();` or the app will not be
  able to read the new column. If a rate ever has to reach a new surface, widen the view,
  never the table grant.
- **Impersonating a user in SQL:** `set_config('request.jwt.claims',
  json_build_object('sub', <user id>, 'aal','aal2','role','authenticated')::text, true)`
  then (optionally) `set local role authenticated`. `auth.uid()`/`is_aal2()` read those
  claims. Do it in `begin; … rollback;`. This is how every C-proof works and how you
  verify any RLS/RPC change. Note: run the *read-back* as the service role (don't `set
  role authenticated`) if you need to see rows the impersonated user can't — the SECURITY
  DEFINER function still gates on the claims either way.
- **The `ops-alert` channel is your smoke detector.** Any failure path calls
  `report_ops_incident(type, detail)`. If it's quiet, things are working; if it's noisy,
  read the `detail`. The HubSpot sync, reminders and webhooks all report through it.
- **pg_net calls are fire-and-forget.** A cron `net.http_post` returns immediately; the
  edge function runs async. To debug a cron, don't watch the cron — watch the function
  logs (`get_logs`) and the ops-alert channel.
- **The bordereau is superadmin-only and export-only.** It reads live data, formats to
  the underwriter template, and never writes. The real template lives in
  `help-docs-src/precedent-bordereau-template.xlsx` — diff against it if the underwriter
  queries a column.
- **Help content persists in localStorage** under `grp_help_v9`. If you change the seed
  in `src/data/mock/help.ts`, bump the key or returning users keep the stale cached seed.
- **Two of everything on the reminder crons is intentional** (07:00 + 08:00 for BST) —
  don't "dedupe" them; the functions are idempotent per day.
- **Migrations are the schema of record** (65 of them under `supabase/migrations/`). I
  applied a couple this week directly via the MCP after writing the migration file;
  they're all committed. When you change schema, write the migration file AND apply it,
  and keep the `supabase_migrations` history in sync with the files (I had to delete one
  reverted migration's record this week when the owner reversed a decision).
- **Go-live is Wednesday 15 July.** The biggest pre-launch risks in priority order: (1)
  the HubSpot sandbox expiry paging you (pause or promote), (2) recreating the hand-
  configured production estate (§6.3) — nothing in `db push` does it for you, (3) the
  `verify_jwt` deploy trap, (4) tearing down the walk-test/paid rows without breaking
  Stripe reconciliation. Do §6.3 as a literal checklist on the fresh project and re-run
  C1–C8 before you trust it.

Good luck. The code is clean and the tests are green; the risk is all in the operational
estate and the integrations, which is what this document is for.

— Handover prepared at tag `v1.0-handover` (commit `4c6b105`), 5 July 2026.
