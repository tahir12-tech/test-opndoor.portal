# opndoor Guarantee Referral Portal - owner's verification script

A systematic, click-by-click walkthrough of the whole product, organised by role.
Work top to bottom; every step is written as **Do X -> Expect Y**. Log anything that
does not match in the findings table at the end. Budget 2-4 hours.

Strictly sandbox/test throughout: Stripe test keys, PandaDoc sandbox, every outbound
email redirected to the review address. Do not enter real card or tenant data.

## Before you start

1. Dev server running: `cd opndoor-portal && npm run dev` (note the printed URL, e.g.
   http://localhost:5173). Expect: the app loads to a sign-in screen.
2. Live mode: `.env.local` has `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`; the
   TEST MODE / Sandbox badges appear once signed in. Expect: real data, not the demo
   model.
3. A second browser (or a private window) so you can hold two role sessions at once
   for the cross-partner probes.
4. Access to the Stripe **test** dashboard and the Supabase **SQL editor** for the
   money and database-proof steps.

### Seeded accounts (password `OpndoorDemo!2026`, each enrols its own TOTP on first login)

| Who | Email | Role | Partner |
|---|---|---|---|
| **Maya** | `maya.holloway@brackenhouse.co.uk` | opndoor admin | opndoor (all) |
| **Tom** | `tom.sefton@brackenhouse.co.uk` | Management | Rightmove |
| **Priya** | `priya.nair@brackenhouse.co.uk` | Referrer | Rightmove |
| **Hannah** (2nd-partner referrer) | `hannah.pryce@brackenhouse.co.uk` | Referrer | Zoopla |
| Greg | `greg.mason@brackenhouse.co.uk` | Management | Zoopla |

Priya owns `GR-20489, GR-20518` (Sent), `GR-20455` (Paid), `GR-20418, GR-20608`
(Deed). Not-Priya's: `GR-20502` (Rightmove, another referrer), `GR-21010` (Zoopla).

### Dates

Figures below assume you are testing in **July 2026** (the demo window; the app's
"today" is the real clock). Two figures move with the date:
- The **settlement card** always shows the **prior calendar month** (June 2026 if run
  in July). Expected June figures are given with a cross-check query.
- The **reminder tiers** depend on days-to-expiry from today. Expected tiers are given
  for today = 03/07/2026; if the date has moved, re-derive from the query provided.

---

## Section 1 - Sign-in, MFA (AAL) enforcement

1. Sign in as **Priya**, correct password, then **close the tab at the 6-digit code
   step** (do not enter the code). Reopen the app. **Expect:** you are back at the
   sign-in / verify step and reach no screen with data (a password-only session is
   AAL1; the database returns nothing at AAL1).
2. Sign in as Priya again and complete TOTP. **Expect:** Dashboard loads; top-right
   shows the period selector and a TEST MODE badge.
3. Repeat sign-in for **Tom**, **Maya**, **Hannah** (each enrols its own authenticator
   the first time). **Expect:** each reaches the Dashboard.

---

## Section 2 - Permission matrix as click-checks

### 2a. Route access (front-end guards)

For each user, type each route in the address bar. **Expect** the outcome in the table
(a "redirected" means you land on /dashboard).

| Route | Priya (Referrer) | Tom (Mgmt) | Maya (admin) |
|---|---|---|---|
| `/dashboard` | ok | ok | ok |
| `/applications` | own only | Rightmove only | all |
| `/new-application` | ok | ok | ok |
| `/agencies` | Rightmove | Rightmove | all |
| `/activity` | own | Rightmove | all |
| `/users` | **redirected** | Rightmove users | all |
| `/partners` | **redirected** | **redirected** | ok |
| `/reconciliation` | **redirected** | **redirected** | ok |

4. As Priya, open each route above. **Expect:** the "own/redirected" column holds.
5. As Tom, repeat. **Expect:** the Management column holds; `/users` shows only
   Rightmove staff (never opndoor staff).
6. As Maya, repeat. **Expect:** everything is reachable.

### 2b. The id probe (cross-partner URL - the important one)

Signed in as **Priya**:

7. Open `/applications/GR-20418` (hers). **Expect:** the full record loads.
8. Open `/applications/GR-20502` (Rightmove, another referrer's). **Expect:** you do
   **not** see GR-20502; the page falls back to one of your own records (the database
   never returned GR-20502 to you).
9. Open `/applications/GR-21010` (Zoopla). **Expect:** same - no Zoopla data reaches
   you. (The database proof of this is Section 8.)

### 2c. Amend boundary (deed-state aware)

The rule: owning Referrer may amend while **Sent** or **Paid-but-unexecuted**; once the
deed is **executed** it is Management/admin only.

Signed in as **Priya**, open each and look for the **Amend start date** button:

10. `GR-20489` (own, Sent) -> Amend visible. Click it, change the date, save.
    **Expect:** allowed; toast confirms; tenancy start + expiry update.
11. `GR-20455` (own, Paid, not executed) -> Amend visible. Amend it. **Expect:**
    allowed (paid-but-unexecuted); toast confirms.
12. `GR-20418` (own, Deed executed) -> **Expect: no Amend button** (executed deeds are
    Management/admin only).
13. Now sign in as **Tom** (Management), open `GR-20418`. **Expect:** Amend **is**
    available. (Section 3 exercises what amending an executed deed does.)
14. As Priya, open `GR-20502` (not hers) - you cannot reach it anyway (step 8). The
    database also refuses a direct amend; proven in Section 8 (C6).

### 2d. Send / resend / replace boundaries

15. As **Priya**, open a Deed-Issued own record (`GR-20418`). **Expect:** a **Send deed
    to agent** button; sending is restricted to the resolved branch/agency contact (no
    one-off recipient field, no "save contact" for a Referrer).
16. As **Tom** or **Maya**, open the same. **Expect:** Send offers a one-off recipient
    and a "save contact" option (Management/admin only).
17. On an **awaiting-signature** deed (create one via Section 3, or GR-20608 before it
    was signed): **Expect** a **Resend signature request** button for the owning
    Referrer, Management and admin; and a **Replace and resend deed** button for
    **Management/admin only** (Priya does not see Replace).

---

## Section 3 - Deed lifecycle (generate -> view -> sign -> issued -> download)

Best driven from a freshly paid application (Section 4 creates one) plus the already
signed `GR-20608`.

18. Take a new referral to **Paid** (Section 4 steps). **Expect:** on the Paid flip the
    Guarantee deed card shows a **Sandbox** badge and "Deed sent for signature,
    awaiting tenant" with the signing journey: **Sent [date/time]** then **Not yet
    viewed**. Activity feed: "Deed of Guarantee sent to the tenant for signature".
19. Check the `EMAIL_REVIEW_ADDRESS` inbox. **Expect:** a PandaDoc signing email
    (redirected from the tenant), sender/subject opndoor-branded ("Your opndoor Deed of
    Guarantee, GR-...").
20. Open the signing link but **do not sign** (just view). **Expect:** the journey row
    flips to **Viewed by tenant [date/time]**; the activity feed gains "Deed viewed by
    the tenant"; the Activity page's Awaiting-signature list shows a **Viewed** date.
21. Re-open the link. **Expect:** no second view recorded (first-view only).
22. Complete the **Signature** field (the only recipient field - there is no Date
    field) and finish. **Expect:** activity feed gains "Deed signed by the tenant";
    within a few seconds the detail flips **Paid -> Deed Issued**.
23. On the issued deed, confirm the printed **dated line** shows the generation date
    (from the `issue_date` merge token). Click **Download deed**. **Expect:** the
    executed PDF opens via a signed URL.
24. **Replace and resend** (as Tom/Maya, on an *awaiting* deed): click it, confirm the
    dialog ("This cancels the deed currently awaiting signature and sends the tenant a
    new one..."). **Expect:** activity logs the void + a fresh send; the old signing
    link stops working; status stays Paid/awaiting.
25. **Decline / void** (optional, in PandaDoc sandbox): decline or void an awaiting
    document. **Expect:** the deed card shows a review warning + a **Generate deed**
    button; status stays Paid; activity logs the decline/void.
26. **Amend an executed deed** (as Tom, on `GR-20418` or `GR-20608`): amend the tenancy
    start. **Expect:** the signed PDF is archived and a **replacement** deed is issued
    for signing (the application reopens to Paid/awaiting); activity logs both the
    archive and the fresh send.

---

## Section 4 - Money path (create -> pay -> decline -> refund)

Signed in as **Priya** (or Tom).

27. **Create & send:** New Application, fill it (postcode lookup or manual), Send.
    **Expect:** you land on the detail page; the Payment card shows **Awaiting payment**
    with a copyable checkout link; the review inbox gets the branded payment email.
28. **Pay (success):** open the pay link (email button or the copied link), pay with
    **`4242 4242 4242 4242`**, any future expiry, any CVC, any postcode. **Expect:** on
    success you land on the public **`/pay/confirmed`** page (payment received,
    amount, reference; then "Sign your deed now" once the deed generates). Back in
    the portal the detail page shows **Paid** with the date (dd/mm/yyyy), amount
    (GBP) and a Stripe reference; the deed auto-generates (Section 3, step 18).
29. **Decline:** create a second referral, open its pay link, pay with
    **`4000 0000 0000 0002`** (declined). **Expect:** the application stays **Sent /
    Awaiting payment**; no status change.
30. **Refund:** in the Stripe **test** dashboard, refund the successful payment from
    step 28. **Expect (in the app):** the Payment card shows **Refunded** with the
    refund reference; **status remains Paid by design**; the activity feed records the
    refund.
31. **Refund visibility & economics:** open the **Dashboard** as Tom/Maya. **Expect:**
    the hero KPI shows Fees collected (gross), **less refunds**, and **net**;
    commission is **net of refunds**; the refunded fee is excluded from commission.
    Application export (Section 5) shows the refund date/amount and 0 commission for
    that row.
32. **Post-start refund anomaly** (if the refund is after the tenancy start): **Expect:**
    the detail flags it loudly (a red "refunded after tenancy start" note) rather than
    silently absorbing it.

---

## Section 5 - Analytics, settlement and exports

Signed in as **Maya** (all partners) unless noted; set the period to **Last 90 days**
or **All time** so figures are non-zero.

### 5a. Dashboard, live

33. **Funnel:** Sent/Paid/Deed counts + conversions. **Expect:** all computed from live
    records (not the old modelled numbers). A small note explains conversion is
    **period throughput** (can exceed 100% when payments land this period for earlier
    referrals). An "**N awaiting tenant signature**" line appears at the funnel.
34. **KPIs:** total guaranteed rent value, fees (gross/refunds/net), commission
    (net, per-partner). **Expect:** no separate "Live payments" block - it is folded
    into the KPIs. Under an all-partners scope the commission label reads "per-partner
    rates" (not a single %).
35. **Charts + trend:** Volume by branch/agency/referrer and the 12-month trend.
    **Expect:** live figures; the referrer chart is real (not invented names).

### 5b. Commission settlement card

36. Scroll to **Commission settlement** (Management/admin). **Expect:** "Partner
    commission accrued on payments in **June 2026** (net of refunds), payable on the
    15th", then one block per partner with constituent applications listed.
37. **Hand-arithmetic (as Maya, all partners; assumes a July run -> June 2026):**
    **Expect** exactly:
    - **Rightmove: £3,290.00** payable on 15 July 2026 - 6 apps: GR-20479 £2,500->£625.00,
      GR-20418 £2,450->£612.50, GR-20471 £2,350->£587.50, GR-20455 £2,200->£550.00,
      GR-20463 £1,880->£470.00, GR-20466 £1,780->£445.00. (Fees £13,160 x 25% = £3,290.00.)
    - **Zoopla: £1,137.50** (£4,550 x 25%).
    - **OnTheMarket: £455.00** (£1,820 x 25%).
    Each row's commission = its fee x 25%; the block total = sum of its rows.
38. As **Tom** (Rightmove): **Expect** only the **Rightmove £3,290.00** block.
39. **Cross-check query** (SQL editor, robust to the current date):
    ```sql
    select p.slug, round(sum(a.monthly_rent * p.partner_rate)
             filter (where coalesce(a.payment_state,'')<>'refunded'), 2) as payable
    from public.applications a join public.partners p on p.id=a.partner_id
    where date_trunc('month', a.paid_at) = date_trunc('month', current_date - interval '1 month')
    group by p.slug order by p.slug;
    ```
    **Expect:** the per-partner totals equal the card. (Payment-date accrual, net of
    refunds; a refunded app contributes £0.)

### 5c. Exports (open each; eyeball the listed items)

40. **Export summary** (Performance, .xlsx). **Expect:** Summary block reconciles to the
    dashboard (funnel counts, conversions, guaranteed value, fees, **net** commission);
    a "Payments and refunds (live)" block; **Commission settlement** section matching
    the card; breakdowns by agency/branch/referrer; a 12-month trend; metaLine ends
    "GBP - Live records".
41. **Application export** (Management/admin; choose basis = **Date paid**). **Expect:**
    one row per live application; columns include Payment state, **Refund date**,
    **Refund amount**, Partner/Agent commission (**0 for refunded rows**), and a
    "Refund policy anomaly" column; filename contains the basis + period.
42. **League export** (from the League page -> Export). **Expect:** three sheets
    (Agencies, Branches, Referrers); commission columns **net of refunds**; the referrer
    sheet is live; metaLine date range matches the on-screen period (not a fixed date).
43. **League page itself:** switch the three tabs; **Expect** all live and
    period-filtered; the referrer tab is real; distinct branches that share a name (e.g.
    across agencies) appear as **separate rows**, not merged.
44. **Bordereau** (Maya only). Open the modal - the label reads **"Month (by tenancy
    start date)"**. Choose **June 2026**, keep the rate. Export. **Expect:** a CSV whose
    **Tenancy Date** column falls within June 2026 for every row (the month anchor is
    tenancy start, NOT issue date); **Issue Date** is the deed's own date and differs
    from the tenancy month; refunded guarantees are excluded; the 19-column header is
    unchanged.
45. **Bordereau cross-check** (SQL):
    ```sql
    select count(*) from public.applications
    where status='deed' and coalesce(payment_state,'')<>'refunded'
      and tenancy_start >= '2026-06-01' and tenancy_start <= '2026-06-30';
    ```
    **Expect:** the count equals the bordereau's "Guarantees issued" line and its data
    rows.

---

## Section 6 - Automated expiry reminders

Signed in as **Maya**, on the **Activity** page.

46. Note the **Upcoming expiries** rows and their "**None sent**" reminder indicator
    (fresh state). Click **Run reminders (test)** (top-right of that card). **Expect:** a
    toast like "Expiry reminders (test) for 2026-07-03: **6 fired**, 0 emailed, 6 failed
    - see admin activity log"; the page refreshes and the fired rows now show
    "**1 sent**".
47. **Tiers** (expected for today = 03/07/2026): GR-19064 (0d, tier d0), GR-19015 (2d,
    d2), GR-19022 (6d, d6), GR-19050 (10d, 14), GR-19029 (14d, 14), GR-19036 (21d, 30).
    Already-expired guarantees (days < 0) are skipped. If the date has moved, re-derive
    with:
    ```sql
    select guarantee_ref, (expiry_date - current_date) as days from public.applications
    where status='deed' and coalesce(payment_state,'')<>'refunded'
      and expiry_date between current_date and current_date + 30 order by expiry_date;
    ```
48. **Idempotency:** click **Run reminders (test)** again. **Expect:** "**0 fired**" (each
    threshold fires exactly once); indicators unchanged.
49. **In-app reminder entry:** open one fired guarantee's detail. **Expect:** a
    business activity entry "Expiry reminder: guarantee expires in N days (dd/mm/yyyy)."
50. **Graceful email degradation:** the "6 failed" above is expected while the Resend
    domain is unverified. **Expect:** as Maya you can see the raw failure only in the
    **admin** activity view; a Referrer/Management never sees a raw 403 (Section 7).
51. **Refunded not in-force:** confirm a refunded Deed-Issued guarantee does **not**
    appear in Upcoming expiries and never accrues reminders.

---

## Section 7 - Activity-feed tiering per role

Pick an application that has had a technical failure (e.g. GR-20608 had PandaDoc/Resend
errors during its history, or use one you just exercised).

52. As **Maya** (admin), open its activity feed. **Expect:** you see **everything**,
    including raw technical rows (PandaDoc 400 payloads, Resend 403 text), each with a
    real `dd/mm/yyyy - HH:mm` timestamp, newest first, no duplicates.
53. As **Tom** (Management) and **Priya** (Referrer), open the same. **Expect:** only
    **business** events (created/sent, paid, deed sent/viewed/signed, reminder sent,
    refunded); **no raw API text**. Where something is stuck, a soft "Deed delivery
    delayed, opndoor has been notified" appears instead of the raw error.
54. Confirm the timeline strip (Sent / Paid / Deed Issued) is a single source with real
    timestamps and one label per event - no duplicated "sent" rows.

---

## Section 8 - Database security proofs (SQL editor)

The SQL editor bypasses RLS, so each block impersonates a user via JWT claims and rolls
back. Full detail in `supabase/SECURITY-PROOF.md`; the load-bearing checks:

55. **Referrer isolation (Priya, AAL2):** run C1. **Expect:** `not_owned_visible = 0`
    and `foreign_partner_apps = 0` (she sees only her own Rightmove rows).
56. **MFA gate (Priya, AAL1):** run C2. **Expect:** `0, 0, 0` - password alone unlocks
    nothing.
57. **Management scoping (Tom, AAL2):** run C3. **Expect:** `foreign_partner_apps = 0`,
    `partners_visible = 1` (Rightmove only; never opndoor staff in users).
58. **Cross-partner referrer (Hannah, Zoopla, AAL2):** run C4. **Expect:**
    `can_see_rightmove_GR20418 = 0`, `foreign_partner_apps = 0`.
59. **Admin (Maya, AAL2):** run C5. **Expect:** sees all partners/users.
60. **Permission rules in the DB (Priya):** run C6. **Expect:** amend OWN sent =
    ALLOWED; amend NON-owned sent = BLOCKED; amend OWN paid-unexecuted = ALLOWED; amend
    OWN executed deed = BLOCKED; send OWN deed = ALLOWED; send NON-owned = BLOCKED;
    one-off recipient/save as a Referrer = BLOCKED.
61. **Contact writes (Priya):** run C7. **Expect:** a Referrer cannot write contacts.

---

## Section 9 - Cross-partner probes via a second-partner login

Hold a **Hannah** (Zoopla referrer) session in a second window.

62. As Hannah, open `/applications`. **Expect:** only her Zoopla referrals; no Rightmove
    or OnTheMarket rows.
63. As Hannah, open `/applications/GR-20418` (Rightmove) and `/applications/GR-20489`
    (Rightmove). **Expect:** neither loads her a Rightmove record (falls back to her own).
64. As Hannah, open the **Dashboard**. **Expect:** figures scoped to Zoopla only; the
    settlement card shows only Zoopla's block (£1,137.50 for June 2026).
65. As Hannah, try `/partners`, `/reconciliation`, `/users`. **Expect:** redirected
    (`/users` is admin/management-of-her-partner only; a Referrer is redirected).
66. Confirm no export or figure anywhere in Hannah's session references a Rightmove or
    OnTheMarket entity.

---

## Findings log

Record every mismatch. Severity: **high** = wrong money/permission/data leak; **medium**
= wrong-but-contained figure or state; **low** = cosmetic/copy.

| # | Step | Expected | Actual | Severity |
|---|---|---|---|---|
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |

**Sign-off:** tester ______________  date __________  build/commit __________
