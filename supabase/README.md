# Backend (Supabase) — foundation

Postgres schema, authentication with MFA, and row level security for the
opndoor Guarantee Referral Portal. Built against Supabase project
`pwftaqtrrqtilxlvwxjd`. This is the foundation stage only: no Stripe, no
PandaDoc, no email delivery yet.

## Authoritative sources

The design is taken from `HANDOFF.md` and the application code in `src/data/`.
There is no `HANDOVER_BALAL.md` in this workspace; the code and `HANDOFF.md`
are authoritative. If that file exists elsewhere, reconcile against it.

## GO-LIVE — required before production

- **Remove or disable the demo seed users.** All 16 seeded users share one
  password (see below). They exist only for the demo and MUST be deleted or
  disabled (and their password reset) before any production launch. They live
  in `auth.users` / `public.users`; delete from `auth.users` cascades the
  profile row.
- **Enable leaked-password protection** (Authentication > Policies): checks new
  passwords against HaveIBeenPwned. Off by default; flagged by the security
  advisor.
- **Confirm TOTP MFA is enabled** (Authentication > Sign In / Providers >
  Multi-Factor): the "Authenticator app (TOTP)" factor must be on. It is on by
  default; the strict AAL2 policy below depends on it.
- **Rotate the Supabase access token** used for local MCP once the build work
  is finished; it is account-wide.

## Demo credentials

- Shared password for every seeded user: `OpndoorDemo!2026`
- Emails follow `first.last@brackenhouse.co.uk`, e.g.
  - opndoor admin (superadmin): `maya.holloway@brackenhouse.co.uk`
  - Management (Rightmove): `tom.sefton@brackenhouse.co.uk`
  - Referrer (Rightmove): `priya.nair@brackenhouse.co.uk`
  - Management (Zoopla): `greg.mason@brackenhouse.co.uk`
  - Referrer (OnTheMarket): `ruth.findlay@brackenhouse.co.uk`

No seed user has an MFA factor yet, so each is forced to enrol TOTP on first
login (see Auth below). This is by design.

## Schema

Six tables, all with RLS enabled:

- `partners` — `partner_rate` / `agent_rate` (per-partner commission), status,
  `live_from`, `is_primary`.
- `users` — 1:1 with `auth.users`; `role` (superadmin | management | referrer);
  `partner_id` null only for opndoor admins (enforced by a check).
- `agencies` — stamped to a partner; `unreviewed` for on-the-fly adds.
- `branches` — under an agency; `partner_id` denormalised (trigger-synced).
- `agent_contacts` — single table, agency-or-branch owner (exactly one, checked);
  one primary per owner (partial unique indexes + trigger); effective contact
  resolved branch-first then agency-fallback via `effective_primary_contact()`.
- `applications` — the referral plus the guarantee; `status` sent | paid | deed;
  `referrer_id` is ownership; `expiry_date` is a stored generated column from
  `guarantee_expiry(tenancy_start)` — the single source of truth, matching the
  app's `guaranteeExpiry` exactly including the Feb-29 edge.

Read-model views (`security_invoker`, so they inherit the caller's RLS):
`activity_feed`, `upcoming_expiries`.

## Auth + MFA

- Email/password first factor; native Supabase TOTP (authenticator app) second
  factor. SMS is a future option (add a factor type, no schema change).
- **MFA required for all users**, enforced in the database: a restrictive RLS
  policy on every table requires `auth.jwt()->>'aal' = 'aal2'`. A password-only
  (AAL1) session can read and write nothing. Enrolment still works at AAL1
  because it uses Supabase's own `auth.mfa_*` APIs, not our tables.
- Login flow: password -> AAL1; then the 6-digit code (existing factor) or the
  enrolment QR (first login) -> `mfa.verify` -> AAL2 -> app.

## Row level security (summary)

- opndoor admin (superadmin): everything.
- Management: their own partner's whole estate.
- Referrer: only applications where `referrer_id = auth.uid()`; read-only on
  their partner's agencies/branches/contacts; cannot write contacts.
- Add-on-the-fly (agencies/branches) allowed for any role within their partner;
  editing canonical records is admin-only.
- The `canAmendTenancyStart` / `canSendDeed` rules are enforced in the database
  by the SECURITY DEFINER RPCs (`amend_tenancy_start`, `send_deed_to_agent`),
  which re-check AAL2, role, ownership and deed state: a referrer may amend only
  their own and only before the deed is executed (Sent, or Paid pre-signature);
  once executed, amends are Management/opndoor-admin only.

Proven behaviourally during the build:
- Priya (Referrer, Rightmove, AAL2): sees exactly her 7 owned applications,
  0 not-owned, 0 cross-partner, 1 partner, only her own user row.
- Same user at AAL1: 0 rows anywhere (MFA gate).

## Security advisor status

- Cleared: mutable `search_path`, contact-resolver exposure, anon execute on all
  functions.
- Accepted (WARN, by design): `authenticated` can execute the 4 lifecycle RPCs
  (their purpose; each self-guards) and the 3 RLS helper functions
  (`app_role` / `app_partner` / `is_admin`, which only return the caller's own
  role/partner). Optional future hardening: move the helpers to a non-exposed
  `private` schema to clear those three.
- Open config toggle: leaked-password protection (see go-live).

## Migrations applied (in Supabase migration history)

1. `core_schema` — functions, tables, triggers, indexes.
2. `access_rls_rpc` — helper fns, RLS policies, lifecycle RPCs, views.
3. `harden_functions` — pin search_path, SECURITY INVOKER resolvers, grants.
4. `revoke_anon_function_execute` — remove anon execute.

Retrieve their SQL any time with `list_migrations` (MCP) or `supabase migration
list`. The seed (partners, users, agencies, branches, contacts, applications)
was applied as data statements, not migrations. A later migration adds an
`applications.beneficiary` column (backfilled from the seed).

## Front-end wiring (Checkpoint 3)

The app talks to Supabase via `src/lib/supabase.ts`. `SUPABASE_ENABLED`
(`env configured && not under test`) switches between:
- Real mode (`npm run dev` / production): real login + TOTP MFA, RLS-scoped
  reads, RPC-backed lifecycle writes.
- Mock mode (vitest / no env): the in-memory seed and dev role switcher, so the
  unit and render smoke tests stay meaningful.

Config: `.env.local` holds `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
(publishable key; safe in the browser). Do not commit it if you add git.

What is wired to Supabase:
- Auth: email/password + TOTP enrol/challenge, AAL2 gate (`RequireAuth`), profile
  + role/partner seeded from the session, store hydrated after login
  (`src/lib/hydrate.ts`). Sign-out in the sidebar footer.
- Reads: all screens, via the four hydrated base datasets (partners, org, users,
  applications). Derived screens (dashboard, league, analytics, activity,
  reconciliation, exports) follow automatically.
- Writes (lifecycle): create referral, amend tenancy start, send deed — via the
  RPCs, permission-checked in the DB.

Session-local for now (update the current view but do not yet persist), a
mechanical follow-on:
- User management (add/deactivate/role) — note: creating a user needs an admin
  endpoint (Edge Function with the service role) because provisioning
  `auth.users` cannot be done from the browser.
- Partner add/edit, agency/branch/contact add/edit, reconciliation approve,
  on-the-fly agency/branch creation during a referral.

The dev role switcher is retained. In real mode it is a UI lens only; data stays
RLS-scoped to the signed-in user.
