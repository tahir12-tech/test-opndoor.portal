# Guarantee Referral Portal — React front end

React front end for the opndoor Guarantee Referral Portal, backed by a live
Supabase back end (Postgres + RLS, native TOTP MFA, Storage, Edge Functions,
pg_cron). It runs in two modes off one switch (`SUPABASE_ENABLED`): **live mode**
(real login + MFA, RLS-scoped reads, Stripe/PandaDoc/Resend via Edge Functions),
and **mock mode** (in-memory seed + the parametric analytics model) used by the
render smoke test and env-less dev. The `src/data/` layer is the single seam
between the screens and both modes.

The back-end setup, security model and test procedures live in `supabase/`
(README, SECURITY-PROOF, PAYMENTS-TESTING, DEEDS-TESTING, EXPIRY-REMINDERS).

British English throughout. Currency GBP. Dates dd/mm/yyyy.

## Stack

- **Vite + React 18 + TypeScript** (strict)
- **React Router** for the screens
- **Plain CSS** — `src/styles/portal.css` is ported verbatim from the
  prototype, every design token preserved under `:root`. Nothing is restyled.
  Page-specific styles are co-located CSS files with the same class names.
- **No UI component library** — components are built from the prototype markup.

## Commands

```bash
npm install
npm run dev        # start the dev server (http://localhost:5173)
npm run build      # type-check (tsc -b) + production build
npm run smoke      # jsdom render test: every route × every role, no crashes
npm run preview    # preview the production build
```

## The one thing to know: the data/service layer

**Screens never touch storage, Supabase or mock data directly. They import only
from `@/data`.** The services stay synchronous: after AAL2 login, `src/lib/hydrate.ts`
replaces the mock working copies with the RLS-scoped live data, and mutations go
through Edge Functions / RPCs. Mock mode keeps the in-memory seed, so the same
screens run with no back end.

```
src/data/
  index.ts                 barrel — screens do `import { getApplications } from '@/data'`
  types.ts                 domain types (mirror HANDOFF §6)
  storage.ts               the ONLY module that touches localStorage
  mock/                    seed data + the parametric analytics model
    partners.ts  org.ts  applications.ts  help.ts  analyticsModel.ts
  partnersService.ts       getPartners, addPartner, updatePartner, getRatesFor, scopeFor, …
  orgService.ts            getAgencies, search*, add*, createAgency/BranchOnTheFly
  applicationsService.ts   getApplications, countByStatus, getApplicationDetail, createReferral, amendTenancyStart
  analyticsService.ts      getDashboardData, getMonthlyTrend, get/setSelectedPeriod
  exportsService.ts        buildPerformanceCsv, buildApplicationCsv, buildBordereauCsv, downloadCsv
  usersService.ts          getUsers, addUser, updateUserRole, deactivateUser, …
  reconciliationService.ts getQueue, confirmRecord, mergeRecord
  helpService.ts           getHelpContent + resource/FAQ/manager CRUD
  authService.ts           real Supabase email/password + TOTP MFA (reset stubbed)
  paymentService.ts        live Stripe payment state + resend-payment-email
  liveAnalytics.ts         live dashboard/league/export figures from the hydrated set
```

Live back-end calls run through Supabase (RLS reads) and Edge Functions
(create-referral, amend-tenancy-start, the Stripe/PandaDoc webhooks, expiry-reminders,
payment-confirmation). The remaining `// INTEGRATION:` / `PENDING:` comments mark
what is genuinely not wired yet (password reset, HubSpot reconciliation, help CMS).

### Session (role + partner scope)

`src/session/SessionContext.tsx` resolves the Supabase session and, at AAL2,
loads the profile and hydrates the service layer. It holds `{ role, partnerScope,
period }`. Management and Referrer are pinned to their home partner; opndoor
admin's scope follows the partner selector. The demo role switcher (`setRole`) is
a UI lens only — data stays RLS-scoped to the signed-in user. Partner/period
persist to localStorage so they survive a reload.

## Structure

```
src/
  main.tsx                 root: Router → SessionProvider → ToastProvider → App
  App.tsx                  route map (auth routes + AppShell layout + role guards)
  styles/portal.css        design system, ported verbatim
  session/                 SessionContext (role / partner scope / period)
  constants/               roles, sidebar nav
  components/
    layout/                AppShell, Sidebar, Topbar, menus, pageMeta
    guards/                RequireRole (opndoor-admin-only routes)
    ui/                    Button, Field, Pill, Tag, Card, Modal, Toast, Icon,
                           FilterTabs, StatusTimeline, BarChart, Pager,
                           Select, TypeAhead, Eyebrow, RoleNote, RoleOnly
    AgentBranchPicker.tsx  the linked agent→branch select-or-add
  pages/                   one folder per screen (Component.tsx + Component.css)
  hooks/                   useOnClickOutside, useDocumentTitle
```

## Routes

| Route | Screen | Access |
|---|---|---|
| `/` | → `/login` | — |
| `/login` | Login (email + password → TOTP) | pre-auth |
| `/forgot-password` | Forgot password | pre-auth |
| `/pay/confirmed` | Tenant payment confirmation + "Sign your deed" | **public** (post-Stripe) |
| `/pay/retry` | Tenant payment retry | **public** (post-Stripe) |
| `/dashboard` | Dashboard | all roles |
| `/league` | League tables | all roles |
| `/activity` | Activity feed + upcoming expiries | all roles |
| `/applications` | Applications (`?agency=` / `?branch=` / `?partner=` / `?status=` / `?deed=awaiting`) | all roles |
| `/applications/:ref` | Application detail | all roles |
| `/new-application` | New application | all roles |
| `/agencies` | Agencies & branches | all roles |
| `/partners` | Partners | opndoor admin (guard) |
| `/users` | Users (`?partner=`, `?team=opndoor`) | opndoor admin + Management (guard) |
| `/reconciliation` | Reconciliation | opndoor admin (guard) |
| `/help` | Help & resources | all roles |

Nav visibility is role-filtered in the sidebar; the opndoor-admin-only routes
are additionally protected by `RequireRole`, which redirects other roles to the
dashboard. (The back end must still enforce every access rule independently.)

## Roles & multi-partner scoping (HANDOFF §2–3)

Three roles: **opndoor admin** (`superadmin` in code), **Management**,
**Referrer**. Role-based visibility is done with the `RoleOnly` component and a
`data-role` attribute on `<html>` for the few CSS-driven variations. Partner
isolation is resolved centrally in `partnersService.scopeFor` + the session and
applied inside the services. Commission rates are **per-partner**
(`partnerRate` / `agentRate` on each partner record) and never hard-coded.

## What IS wired to the live back end

Real email/password auth + native TOTP MFA (AAL2-gated RLS); referral creation
with Stripe test Checkout + branded Resend email; PandaDoc deed generation,
signing, reminders and the public tenant confirmation/signing page; refunds;
tenancy-start amend with deed reissue; automated expiry reminders (pg_cron);
and all analytics/exports computed from the live records in live mode. In mock
mode (no env / under vitest) the parametric model in
`src/data/mock/analyticsModel.ts` and the in-memory seed drive the same screens.

## Genuinely pending

Password reset (stubbed — Supabase `resetPasswordForEmail` + a set-new-password
page); HubSpot sync and the reconciliation queue's live wiring; the help-content
CMS (client-side data-URLs today); and the documented `pg_net` schema move. See
the `// INTEGRATION:` / `PENDING:` comments and `supabase/SECURITY-PROOF.md`.
