# Handover: taking `partner-api` to production

**For Balal.** Written to be worked through in order. Nothing here has been run
against production by me; every command below is yours to run, and the first
section exists so that you never run one of them for the first time on the real
database.

Two project refs matter, and confusing them is the only unrecoverable mistake in
this document:

| | ref | what it is |
|---|---|---|
| **dev** | `nfufwcpgrhfgwtphegca` | where all of this was built and proved. Safe. |
| **production** | `xogpsaoyprgmxdkmcype` | the live portal. **Do not point anything at this until section 3.** |

You will also create a third, throwaway **clone**, and that is where you start.

---

## 0. What this actually is

`partner-api` is 284 migrations ahead of `origin/main`.

```
migrations on this branch      349
migrations on origin/main       65
new                            284

edge function directories       34   (plus _shared)
on origin/main                  21
```

*Counts refreshed 2026-09-30, and they are counted rather than remembered:
`ls supabase/migrations/*.sql | wc -l` against
`git ls-tree -r --name-only origin/main -- supabase/migrations/`. If you read
this on a later day, count them again rather than trusting the number.*

Production is running `origin/main`, whose schema has not changed since 5 July.
The branch is not a feature on top of it; it is most of a year of work, and the
single biggest risk in this handover is treating it as a normal deploy.

**The SCHEMA goes over in one push, all 268, in filename order, never split.**
That is Matt's instruction and it is also the only thing that works:
migrations are interleaved by date rather than by feature, and the later ones
replace functions the earlier ones create, so there is no subset that is both
coherent and smaller.

What is taken in **six bites** (section 5) is the ROLLOUT — what you deploy,
switch on and point at the database afterwards. The schema being present
changes nothing a user can see until its function is deployed, its cron is
scheduled or its screen is shipped. **After the push, production behaves
exactly as it did before**, and that is the property that makes this safe.

**Only bite 1 plus Regent's keying has to be true on the day.** The other
five can follow that week.

**One ordering rule inside that, and it is absolute: bite 1 before bite 2.**
The front end asks for a column that migration `20261007600000` adds, in the
select that runs at sign-in, so the new bundle against the old schema locks
every user out rather than degrading. Section 3.5 is the step, with the SQL
check to run before you deploy it.

---

## 0a. Read this before anything else: 2026-09-29

Four things changed after this document was written, and the first one comes
BEFORE the cutover rather than as part of it.

### There is no longer a separate hotfix. It is part of the cutover.

**Superseded, 2026-09-30.** There WAS a `docs/HOTFIX-LIVE-FOR-BALAL.md` to
apply to production before the cutover. Matt's decision: *"there is no
separate live hotfix. Everything in HOTFIX-LIVE-FOR-BALAL.md ships with the
cutover instead."* The document is retired and both files are deleted; there
is nothing for you to run by hand and nothing to do before the cutover.

Everything it contained is a migration on this branch, each with a test:

| what it closed | where it is now |
| --- | --- |
| a manager could mark an application paid without paying, by sending one request straight to the database | `20261006720000`, with `the_live_hotfix_holds.test.sql` and `the_browser_does_not_write_an_application.test.sql` |
| a sign-in with no user profile was treated as **allowed** rather than refused, by twelve functions -- one of which let such an account promote any negotiator, at any company, to manager | `20261006470000`, with `a_null_guard_refuses.test.sql` |
| a refund of anything other than the whole fee | `20261006910000`, with `a_refund_is_the_whole_fee.test.sql` |
| the scheduled-job log growing for ever | `20261006960000` |
| the Health screen timing out | `20261006950000`, with `the_health_screen_is_quick.test.sql` |

**The last two are not what the hotfix said they were**, and the difference
matters to you because one of them was an instruction you would not have
been able to carry out.

- The hotfix asked for an index on `cron.job_run_details`. **It cannot be
  created.** `create index` on that table is refused with "must be owner of
  table job_run_details": pg_cron's tables belong to `supabase_admin`, and
  neither a migration nor you running SQL as `postgres` can do it. Measured
  on dev.
- It also asked for 30-day retention, on the understanding that the log's
  SIZE was the problem. Measured: trimming to 30 days took the Health screen
  from 46.7 s to 37.1 s, against an 8 s cut-off; even 7 days only reached
  25.2 s. The size was never the cause.

  The cause was the query: one expensive set computed twice, each read
  seq-scanning 35 MB once per HTTP response. `20261006950000` reads it once,
  through the primary key. **46.7 s to 0.67 s on dev**, with the log still
  untrimmed. The retention job ships too, as housekeeping, and you should
  expect the first run to delete a few weeks' backlog in one go.

### Your local `main` is NOT what production runs

This is the one that could waste a day. The local branch `main` (`f2816a7`)
and the live repository's `origin/main` (`3520a26`) have **diverged**:
neither contains the other. `origin/main` carries eight commits from
27 August to 18 September that the local copy does not — deed email fixes, a
PandaDoc wait, a refund timeout, toast fixes.

Their `supabase/migrations` trees are **byte-identical**, 65 files each, so
every statement in this handover about the DATABASE is unaffected. It is the
application code that differs. **Apply the hotfix against the live
repository's branch, not the local one.**

### Ten more migrations, and what they are

They are in the apply order below like everything else; nothing special is
needed for them. Listed because three change behaviour you would otherwise
meet by surprise.

| | migration | what it does |
|---|---|---|
| 1 | `20261006720000_the_branch_is_at_least_as_strict_as_the_hotfix` | revokes DELETE and TRUNCATE on `applications` (round 7 named only INSERT and UPDATE), and brings `app_role()` into line with the production hotfix so the two databases hold the same definition |
| 2 | `20261006730000_no_portal_identity_has_two_spellings` | the sandbox guard accepts both spellings of "no portal identity". **Without this the partner API's sandbox stops working**, which is how it was found. |
| 3 | `20261006740000_the_cron_may_mint_a_statement_reference` | **the monthly commission statement has never been sent, to anybody.** The permission check refused the only caller that runs it. Not a production fault — that subsystem does not exist on `main` — but it would have shipped broken. |
| 4 | `20261006750000_a_counter_belongs_to_a_route` | volume counters become per-route, so an agency under two suppliers has two counters and not one pooled total |
| 5 | `20261006760000_an_agency_on_two_routes_shows_two_counters` | the same, on the screen |
| 6 | `20261006770000_a_statement_reference_is_a_commercial_artefact` | a Manager can no longer read statement references |
| 7 | `20261006780000_the_second_factor_is_not_optional_on_the_money` | **an Opndoor admin with only a password could change commission rates.** Nine tables were missing the MFA rule that eighteen others had. |
| 8 | `20261006790000_a_supplier_statement_has_a_stored_reference_too` | a supplier's statement can carry the stored `STMT-YYYY-MM-NNNN` |
| 9 | `20261006800000_an_admin_chooses_the_route` | admin New application can state which supplier a referral came through; the server refuses one the branch does not sit under |
| 10 | `20261006810000_one_create_referral_not_two` | drops the older `create_referral` overload the one above created |

### The part of the walk only you can do

`docs/THE-WALK.md`. Every rail was created on dev and every resolver asked
what it produced and **who it would tell** — the fees, the rates, the
recipients.

What could not be walked from here is payment, deed generation and the
emails: no card can be charged and no inbox can be read from a terminal. The
browser steps are listed at the end of that document.

**The one to watch is step 7: who is on the executed-deed email.** That has
been wrong before, and it is the step where being wrong costs a customer
their deed.

### Before go-live: check who the emails come FROM

Matt, 2026-10-01: "on live, emails must send from a verified opndoor.co
address, not onboarding@resend.dev, checked before go-live."

**UPDATED 2026-10-01.** Matt: "Every email is sent from
no-reply@opndoor.co (display name 'opndoor'), with no Reply-To ... The
sender address is a setting, not hardcoded. Add to HANDOVER-BALAL.md:
verify opndoor.co in Resend and set the sender to no-reply@opndoor.co
before go-live, with a check."

**The sender is now a SETTING, not an environment variable.** It lives
in `app_settings` under the key `email_from`, is read by
`public.email_from()`, and an Opndoor admin can change it without a
deploy. `mailer.ts` takes the first of these that is present:

| order | source | why it exists |
|---|---|---|
| 1 | `app_settings.email_from` | what an admin changes, audited |
| 2 | `EMAIL_FROM` | so a deployment can send before anybody can sign in to set it |
| 3 | `opndoor <no-reply@opndoor.co>` | so an email is never unsendable for want of configuration |

Each is a fallback for the one before being ABSENT, never for it being
wrong. **There is no Reply-To on any email** as of 2026-10-01: the
sender is a no-reply mailbox and the footer carries a mailto link to
support@opndoor.co.

**What to check, on the live project, before the first real send:**

1. The domain `opndoor.co` is VERIFIED in Resend, with its DKIM and SPF
   records live. An unverified domain is why `onboarding@resend.dev`
   exists, and Resend will refuse or rewrite a from-address on a domain
   it cannot verify.
2. The mailbox `no-reply@opndoor.co` exists on that domain. Note the
   HYPHEN: the old default was `noreply@`, which is a different mailbox.
3. `app_settings.email_from` reads `opndoor <no-reply@opndoor.co>`.
4. `EMAIL_FROM` is **unset** on live, so the setting is what is in
   force. If it is set it WINS, and an admin changing the setting will
   appear to do nothing.
5. `EMAIL_REVIEW_ADDRESS` is **unset** on live. It redirects every email
   to one inbox, which is right on dev and would mean no customer ever
   receives anything on production.

Point 5 is the one that is silent: everything succeeds, the logs say
sent, and the mail is all in one mailbox.

#### The check

Run this against LIVE. It answers 3 and 4 together, and prints what
every email will actually be sent from.

```sql
select
  coalesce(public.email_from(), '(setting unset)')        as setting,
  coalesce(current_setting('app.email_from_env', true),
           '(check the dashboard: EMAIL_FROM)')           as env_var_note,
  case
    when public.email_from() is null
      then 'FAIL: no setting; the function falls back to its built-in default'
    when public.email_from() not like '%no-reply@opndoor.co%'
      then 'FAIL: not the no-reply@opndoor.co mailbox'
    when public.email_from() !~ '^[^<>]+<[^<>@[:space:]]+@[^<>@[:space:]]+\.[^<>@[:space:]]+>$'
      then 'FAIL: not in the "Name <address>" shape Resend parses'
    else 'OK'
  end                                                      as verdict;
```

`env_var_note` cannot be read from SQL -- an edge function's environment
is not visible to Postgres -- so check `EMAIL_FROM` in the Supabase
dashboard under Edge Functions → Secrets and confirm it is **not set**.

And one live send, to yourself, from the invite flow. Confirm:

- it arrives from **opndoor &lt;no-reply@opndoor.co&gt;**;
- the footer reads **Questions? Email support@opndoor.co** and the
  address is a working mailto link;
- pressing **Reply** offers no-reply@opndoor.co and not a support
  address -- that is correct now, and is why the footer carries the
  mailto.

---

## 1. FIRST: rehearse on a clone. Do not skip this.

Nothing below has been run against a database that has production's DATA in it.
Dev has production's SCHEMA (I applied every migration there) but a different,
much smaller book. The rehearsal is how you find out what 178 migrations do to
real rows.

### 1.1 Make the clone

In the Supabase dashboard: production project, then Database, then Backups, then restore the
most recent backup **into a new project**. Call it something unmistakable, e.g.
`opndoor-cutover-rehearsal`. Note its ref; everything in this section uses it.

> Restoring into the SAME project is the mistake to avoid. If the dashboard ever
> offers "restore in place", you are on the wrong screen.

### 1.1b The fresh-database proof, which is the one that matters most

Apply the migrations to the clone **from zero, in filename order, in one run**,
and then run BOTH test suites against the clone before production is touched.
That is the only thing that proves the files are self-consistent. Everything
else I can tell you was measured against dev, and dev is a working copy that
has had migrations run against it by hand.

That distinction is not theoretical. On dev, an earlier migration had been
re-applied after a later one, so dev and the files disagreed, and a revoke
that made **every user invite fail** sat green in the test suite for a day
because the tests were measuring dev. Three separate locks were found the same
way: new invites, "Remove position", and `set_home_branch`. All are fixed, and
the process that hid them is what this step exists to defeat.

```bash
# From zero, in filename order, in ONE run. Never file by file, and never
# re-running one that has already gone in.
supabase link --project-ref <clone-ref>
supabase db push            # applies every migration in supabase/migrations, in order

# Then BOTH suites, against the clone.
supabase test db            # the pgTAP suite: 35 files
npm test                    # the web suite: 89 files
npm run typecheck
```

Two of those suites are there specifically to catch what bit us:

- `supabase/tests/the_work_still_works.test.sql` asserts that the ordinary
  actions still SUCCEED: invite a user, move them, remove a position,
  change a level, deactivate, reset MFA, read your own book, withdraw, add a
  note, reach the deed path. Every other file in that directory asserts a
  refusal. A suite of refusals cannot see a lock that stops real work, and
  that is exactly what shipped green.
- `supabase/tests/definer_grants.test.sql` asserts that no SECURITY DEFINER
  function is callable by `anon`, and that every one callable by
  `authenticated` is on an allowlist derived from the migration FILES.

**If `supabase db push` fails part way, stop.** Do not apply the rest by hand
and do not re-run the one that failed. Fix the migration, re-make the clone,
and start again. A half-applied chain is the state that produced every problem
above.

### 1.1c Check the files against themselves, before you even make the clone

Two of these need no database at all and take seconds:

```bash
npm run schema:final   # replays every migration in filename order and reports
                       # the final grant state, plus any function whose return
                       # type changes without a DROP (a 42P13 on a clean apply)
npm test               # includes migrationPatterns and testsRunAsTheirRole
```

And once the clone exists and is linked, this compares the two:

```bash
QSH=<a script that runs SQL against the clone> npm run drift
```

`npm run drift` computes what a clean apply of the files WOULD produce -- grants,
function bodies, policies, triggers, column privileges -- and diffs it against a
live database. Against dev it must print "No drift". Against the clone, after
`supabase db push`, it must print the same. If it does not, the clone and the
files disagree and something was applied out of order.

### 1.2 Capture the before picture

These run under `psql`, not the SQL editor: `10_capture.sql` takes a `label`
variable and is run **twice**, once before the migrations and once after, so the
comparison is between two labelled snapshots of the same database.

```bash
export CLONE="postgres://postgres:<password>@db.<clone-ref>.supabase.co:5432/postgres"
cd scratchpad/invariance

psql "$CLONE" -v ON_ERROR_STOP=1 -f 00_setup.sql
psql "$CLONE" -v ON_ERROR_STOP=1 -f 10_capture.sql -v label=before
```

`00_setup.sql` creates the capture tables. `10_capture.sql` walks every table
through `to_jsonb(t.*)` and every function through the catalogue, so it runs
unchanged against both the old schema and the new one. That last property is the
whole trick: the same script describes both worlds.

### 1.3 Apply the migrations

```bash
cd ../..                                  # back to the repo root
npx supabase link --project-ref <clone-ref>
npx supabase db push
```

`db push` applies only what is missing, in filename order. Expect 178. If it
stops, it stops on the first failure: everything before it is applied and
committed, everything after is not. Fix and re-run; it is resumable.

### 1.4 Capture the after picture, and compare

```bash
cd scratchpad/invariance
psql "$CLONE" -v ON_ERROR_STOP=1 -f 10_capture.sql -v label=after
psql "$CLONE" -v ON_ERROR_STOP=1 -f 20_compare.sql
psql "$CLONE" -v ON_ERROR_STOP=1 -f 30_expected_changes.sql
psql "$CLONE" -v ON_ERROR_STOP=1 -f 40_new_surface.sql
```

`20_compare.sql` diffs before against after. `30_expected_changes.sql` is the
allow-list: the things that are SUPPOSED to move, so the diff can be read rather
than stared at. `40_new_surface.sql` lists what is newly reachable, which is how
you check that nothing became reachable that should not have.

**What a good result looks like:** every existing application's `status` and
commission unchanged; no partner's rates moved; no policy removed from a table
that had one. New tables, new columns and new functions are expected and listed.

**The one change you SHOULD see and must not be alarmed by:** every existing
application gains `fee_amount = monthly_rent` and `fee_basis_weeks = 4.33`. That
is `20260928100000` backfilling the fee, and it is a no-op in money terms,
because until this branch the fee WAS one month's rent.

**Stop and tell Matt** if any existing row's `status` or commission moved.

> The scripts' own headers say "166 migrations". They were written when there
> were 166; there are now 201. The scripts themselves are generic and do not
> count, so the number in the comment is stale and harmless. The same goes for
> any count written in this document before the branch stopped moving: the
> authoritative answer is always the `ls | wc -l` in 1.4, never a number typed
> into prose.

### 1.4b The commission rates and deals survived, and a referral still freezes them

**Why this check is new.** `20261007680000` stopped "Add supplier" handing out a
silent 25% / 10% commission deal. It drops the DEFAULT on
`partners.partner_rate` and `partners.agent_rate` and makes both columns
nullable, so a supplier created from now on has no deal until somebody sets
one.

**It changes no existing row**, and that is exactly the claim to verify rather
than take on trust: dropping a default cannot alter a value that is already
there, and on dev all eleven partners kept their rates. The clone is where that
is confirmed against LIVE data, which nobody has inspected.

**And one thing genuinely behaves differently afterwards.** `resolve_rates` now
coalesces its answer to `0` as a last resort. Before, the columns were NOT NULL
so there was nothing to coalesce; now a partner with no rate and no agreement
prices a referral at nothing rather than failing on
`applications.partner_rate`'s NOT NULL. That is deliberate (refusing such a
referral outright is an After-launch item), but it means **a supplier whose
rates went missing would be silent instead of loud**. Hence check 3.

#### 1. Every partner's rates are exactly what they were

```sql
-- Run BEFORE the migrations, keep the output, run again AFTER, and diff.
-- `20_compare.sql` covers this generically; this is the same claim in a form
-- you can read without reading a diff.
select slug, partner_rate, agent_rate
  from public.partners
 order by slug;
```

- [ ] identical before and after, row for row

#### 2. Every live supplier's commission agreement is still there

```sql
select p.slug,
       p.partner_rate,
       p.agent_rate,
       count(pa.id) filter (where pa.kind = 'commission'  and pa.ended_at is null) as commission_deals,
       count(pa.id) filter (where pa.kind = 'agent_share' and pa.ended_at is null) as share_deals
  from public.partners p
  left join public.pricing_agreements pa
         on pa.scope_level = 'partner' and pa.scope_id = p.id
 where p.partner_kind = 'supplier'
 group by p.slug, p.partner_rate, p.agent_rate
 order by p.slug;
```

- [ ] every supplier that had an agreement before still has one
- [ ] Rightmove's row reads the rates you expect, and you have checked them
      against what Rightmove is actually contracted to

#### 3. Any supplier with rates but NO agreement row: LIST IT FOR MATT

Matt's own words: *"If any live supplier has rates without an agreement row
(like New Supplier 2 on dev), list it for me before go-live."*

```sql
select p.slug, p.name, p.partner_rate, p.agent_rate
  from public.partners p
 where p.partner_kind = 'supplier'
   and (p.partner_rate is not null or p.agent_rate is not null)
   and not exists (
     select 1 from public.pricing_agreements pa
      where pa.scope_level = 'partner' and pa.scope_id = p.id
        and pa.kind = 'commission' and pa.ended_at is null)
 order by p.name;
```

**On dev this returns four: ACME TEST, New Suplier, New Supplier 2 and New
Supplier 3.** Each got 25% / 10% from the old default with nobody agreeing it,
and each has `rate_edits = 0` in `partner_audit`. They are test rows and were
deliberately left alone.

On LIVE the same query may return a real company being paid a rate nobody
recorded a deal for. That is a commercial question and not a technical one.

- [ ] query run, output pasted to Matt, **before go-live**
- [ ] empty result, or Matt has seen the list and said to proceed

#### 4. A test referral through Rightmove freezes the real rates, not 0

Do this during the clone walk (section 11), with a referral through Rightmove
rather than a hand-written insert: the point is to exercise `resolve_rates` and
`freeze_commission_lines` the way the product does.

```sql
-- Replace GR-XXXXX with the reference the walk created.
select a.guarantee_ref,
       a.partner_rate        as frozen_on_the_application,
       a.agent_rate          as frozen_agent_rate,
       l.level, l.rate, l.basis_amount, l.amount
  from public.applications a
  left join public.application_commission_lines l on l.application_id = a.id
 where a.guarantee_ref = 'GR-XXXXX'
 order by l.level;
```

- [ ] `frozen_on_the_application` is Rightmove's real rate, **not 0 and not
      null**
- [ ] there is a `supplier` line, and its `rate` matches
- [ ] the `amount` is that rate times `basis_amount`, to the penny

**A zero here is the failure this check exists for.** It would mean the
referral resolved no rate and took the new fallback, and it would be silent
everywhere else: the application is created, the statement shows nothing owed,
and the first person to notice is Rightmove.

**Stop and tell Matt** if any of the four boxes above is unticked.

### 1.5 Then walk it

Deploy functions and secrets to the clone (sections 6 and 7 with `$CLONE`), then
run the clone walk in section 11. That is the rehearsal proper: the migrations
applying cleanly is necessary and not sufficient.

**Point the new front end at the clone for this, and do it in the cutover order:
migrations (1.3), then the front end.** This is where the 3.5 dependency gets
rehearsed rather than discovered. Signing in to the clone on the new bundle is
the test, and it is the same single action that proves it on the day.

---

## 2. Knowing what is applied where

The question "which migrations does this database have" is answerable directly.
Run against any project:

```sql
-- What the database thinks it has applied.
select version, name
from supabase_migrations.schema_migrations
order by version;
```

```sql
-- How many, and where it stops.
select count(*) as applied,
       min(version) as first,
       max(version) as last
from supabase_migrations.schema_migrations;
```

To diff a database against this branch, run the first query, save it, and:

```bash
# the branch's list
ls supabase/migrations/*.sql | xargs -n1 basename | sed 's/_.*//' | sort > /tmp/branch.txt
# paste the database's version column into /tmp/db.txt, then:
comm -23 /tmp/branch.txt /tmp/db.txt   # on the branch, NOT in the database
comm -13 /tmp/branch.txt /tmp/db.txt   # in the database, NOT on the branch  <-- investigate any
```

The second list should be empty. Anything in it was applied to that database by
hand and is not in version control, which you need to know about before you push
anything.

---

## 3. Production runbook

Do this only after section 1 has passed on a clone.

### 3.1 Before you touch anything

```bash
# A fresh backup, taken by you, whose restore point you know.
# Dashboard -> Database -> Backups -> "Backup now". Wait for it to complete.
# Write the timestamp here: ____________________
```

Confirm you are pointed at the right project and say it out loud:

```bash
npx supabase link --project-ref xogpsaoyprgmxdkmcype
npx supabase projects list      # confirm the linked one is highlighted
```

### 3.2 Announce

The migrations take a few minutes and the schema changes under the running app.
Nothing here drops a column or a table, so a browser holding the old bundle keeps
working, but a referral created mid-push could land before its own new columns
exist. Pick a quiet window. Twenty minutes is plenty.

### 3.3 Push

```bash
npx supabase db push
```

Watch it. If it fails, note the migration it failed ON: everything before it is
applied and committed, everything after is not.

### 3.4 Verify before you let anyone in

```sql
-- 1. Count. Should match the branch.
select count(*) from supabase_migrations.schema_migrations;

-- 2. Nothing lost. Every one of these should return zero.
select count(*) from public.applications where status is null;
select count(*) from public.applications where fee_amount is null;
select count(*) from public.partners where partner_rate is null;

-- 3. The fee backfill is a no-op in money terms.
select count(*) as should_be_zero
from public.applications
where abs(fee_amount - monthly_rent) > 0.005
  and pricing_agreement_id is null;

-- 4. The new sequence guard found nothing pre-existing.
select count(*) as out_of_order from public.applications where sequence_anomaly;
```

### 3.5 Deploy the front end, and NOT before the migrations

**This is bite 2 (section 5), and it has a hard dependency on bite 1 that the
earlier wording did not state.** Do it after 3.3 has succeeded and 3.4 is clean.
Not alongside, not first.

**Why the order is mandatory, not tidy.** The new bundle asks the `partners`
table for a column called `partner_kind`, by name, in the select that runs
immediately after sign-in (`src/lib/hydrate.ts`). It is added by migration
`20261007600000`. Against a database that has not had that migration applied,
PostgREST answers that select with an error, `hydrateFromSupabase` throws, and
`SessionContext` deliberately does not set `ready` when hydration fails. The
symptom is not a missing Suppliers list or a blank chart:

> **Nobody can sign in.** Every user who authenticates is returned to the
> sign-in screen with no way forward, including you.

It is the same fail-closed shape as `generateDeed` and its lease in 6b, and it
fails for the whole estate rather than one journey. There is no partial state
and nothing to notice early: the first person to try is the first to find out.

The reverse order is harmless. The migration on its own changes nothing a user
can see, because the old bundle never asks for the column.

```bash
# ONLY after 3.3 succeeded and 3.4 returned zeros.
npm run typecheck && npm run build
# then publish dist/ the way this project publishes it,
# keeping the previous build's artefact (see "Why bite 2 is the one to watch").
```

#### The check, before you deploy the front end

Run this against **production**. It must return `t`. If it returns `f`, or no
row, stop: 3.3 has not finished and the bundle will lock everyone out.

```sql
select exists (
  select 1 from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'partners'
     and column_name  = 'partner_kind'
) as safe_to_deploy_the_front_end;
```

Belt and braces, because the column existing is not quite the same as the
migration having been recorded:

```sql
-- Should return one row. If it returns none, the column came from somewhere
-- other than the migration and you want to know why before you ship.
select version from supabase_migrations.schema_migrations
 where version = '20261007600000';
```

> **Run that second one on production or the clone, NOT on dev.** Both of those
> get their migrations through `supabase db push`, which records every file it
> applies, so the ledger is trustworthy there. Dev does not: its
> `schema_migrations` stops at `20260922110000` while the branch has 411 files,
> because everything since has been applied to dev directly. That is the
> standing reason `npm run drift` is the authority on this project and the
> ledger is not. On dev the first check returns `t` and the second returns
> nothing, and neither tells you anything is wrong.

If you want the bluntest possible version of the first check, ask the database
the same question the app asks. It errors rather than returning `f`, which on a
pre-deploy gate is the more useful shape:

```sql
select partner_kind from public.partners limit 1;
```

#### And the check after it

Sign in as one real user on the new bundle before you let anyone else in. A
successful sign-in is the whole test: it is the thing that breaks, and it
cannot half-work.

- [ ] `safe_to_deploy_the_front_end` returned `t`
- [ ] `20261007600000` is in `schema_migrations`
- [ ] front end deployed, previous artefact kept
- [ ] signed in successfully on the new bundle

### 3.6 Rollback

**There is no "unapply migrations" button, and you should not go looking for
one.** 178 migrations include column drops, type changes and data backfills; a
reverse script would be longer than the forward one and would itself be
unrehearsed. The rollback is the backup.

| situation | what to do |
|---|---|
| `db push` failed part way and the app is broken | Restore the backup from 3.1. You lose anything written since. This is why the window is short and announced. |
| `db push` succeeded, app is broken | Restore the backup. Same cost. |
| `db push` succeeded, app works, one screen is wrong | **Do not restore.** Fix forward. A restore to undo a cosmetic fault costs real money written since the backup. |
| One bite is wrong and later bites are not applied | Nothing to roll back: bites 2 to 6 are additive and unreferenced until their code ships. |

The practical consequence: **the decision to restore has to be taken within
minutes, not hours**, because the cost is everything written since. Agree in
advance who makes that call.

---

## 4. Keying Regent

`scratchpad/regent/01-key-regent.sql`. Copy it into the production SQL editor and
read it before running; it is 159 lines and commented throughout.

It is **idempotent** and **self-verifying**: it opens a transaction, makes the
agency, and then prints ten verification rows. You read them, and then you type
`COMMIT` or `ROLLBACK` yourself. It does not commit for you.

What it makes:

- **Regent Property**, an agency under the house partner `opndoor-agents`. That
  is what puts them in our estate: org tree, agreement, joint tenancies,
  commission split per tenancy.
- **Their own referencing route** (`pre_referenced_open`), so their applicants go
  straight to a payment link with no eligibility form.
- **Their deal**, as a pricing agreement: 1 tenant 3 weeks at 20%, 2 or more 5
  weeks at 25%.

What it deliberately does not make:

- **No explicit `agent_rate` on the agency.** The agreement IS their rate. A
  party holds one or the other, never both, and the trigger refuses the pair.
- **No user invite.** Inviting Rosa is a UI action so that she gets a real
  branded email. Do it from the portal after the script commits.

The ten verification rows to read before committing:

| # | check | expected |
|---|---|---|
| 1 | agency exists, on the estate, referencing its own tenants | true |
| 2 | no explicit rate on the agency | true |
| 3 | branches | 1 |
| 4 | exactly one live agreement | 1 |
| 5 | the bands | 1 tenant / 3 wks / 20%, 2+ / 5 wks / 25% |
| 6 | a £2,000 single tenant is charged | £1,384.62 |
| 7 | a £2,000 pair is charged, once | £2,307.69 |
| 8 | commission at one / at two | 20% / 25% |
| 9 | the form will offer a second tenant | true |
| 10 | deed delivery is ready | **false until Rosa accepts her invite** |

Row 10 being false is expected and is not a blocker: deed delivery resolves to
*active* people, and an invited-but-not-accepted manager is not active. It turns
true when she signs in. **Check it again after she does**, because until it is
true her deeds park for a staff send.

---

## 5. The six bites

**First, a correction to how this sounds.** "Six bites" does not mean six
database pushes. It cannot: migrations apply in filename order, they are
interleaved by date rather than by feature, and the later ones replace functions
the earlier ones created. There is no subset of the 268 that is both coherent and
smaller. The schema goes over in **one push**.

What IS bitten is the ROLLOUT: what you deploy, switch on and point at the
database afterwards. The schema being present changes nothing a user can see
until its function is deployed, its cron is scheduled or its screen is shipped.
That is the property that makes this safe, and it is worth understanding before
you start: **after the push, production behaves exactly as it did before.**

| # | bite | what you do | user-visible effect | Monday? |
|---|---|---|---|---|
| **1** | **Schema** | `db push`. All 268, in filename order, in one run. | **None.** New tables, columns and functions nothing yet calls. | **YES** |
| **2** | **The app** | Deploy the built front end. **Only after bite 1: see 3.5.** | Everything the UI does: the estate screens, Team, the new Applications and Reporting, agreements. **This is the big one to watch.** | **YES** |
| **3** | **Regent** | Run the keying script (section 4), invite Rosa. | Regent exists and can refer. | **YES** |
| 4 | Core functions | Deploy the 12 new edge functions; set their secrets; point the webhooks. | The tenant journey end to end: payment page, deeds, tenant portal, partner API. | only what Regent's journey touches |
| 5 | Scheduled work | Schedule `commission-statements-0700/0800`. Everything else is already scheduled. | The monthly statement email. | no, first send 1 November |
| 6 | Integrations | HubSpot sync, partner webhooks, the Dev Centre. | Partner-facing plumbing. | no |

**For Monday you need 1, 2, 3, and the part of 4 that Regent's own journey
touches**: `payment-page`, `stripe-webhook`, `pandadoc-webhook`,
`send-deed-to-agent`, `create-referral`. The rest can follow that week.

### Why bite 2 is the one to watch

Bite 1 is invisible and bite 3 is one reversible script. Bite 2 replaces every
screen at once, and it is the only step with no partial state: a user has either
the old bundle or the new one. If something is wrong, rolling back is
redeploying the previous build, which is fast and costs nothing. **Keep the
previous build's artefact.**

**And it depends on bite 1, which is new in this release.** The bundle asks
`partners` for `partner_kind` (migration `20261007600000`) in the select that
runs at sign-in, and that select failing stops sign-in for everybody rather
than breaking one screen. Deploy bite 2 against a database without bite 1 and
nobody can get in, you included. **Section 3.5 is the step and the check.** The
table above is in dependency order for this reason, not only for nerves.

### A dependency worth knowing

The per-tenant deed rule (`20261005110000`) supersedes the one-deed-per-tenancy
rule from earlier in the same push. Both are in bite 1, so this does not bite
you, but if Regent sends a joint tenancy the deeds are per tenant from the
first one. There is no retrofit for tenancies issued under the old rule, and
production has none, because production has no joint tenancies at all.

## 6. `supabase/config.toml`, and deploying the functions

The file in the repo is the source of truth. The entries that matter are the JWT
gates: a function invoked by a cron, by a third-party webhook, or by a browser
with no session cannot present a user JWT, so it must be listed with
`verify_jwt = false` and authenticate itself another way. The platform check runs
*before* the function's first line, so a missing entry is a 401 nobody sees.

**Corrected 26 September.** This section previously said there were seventeen
entries and that `partner-api` was deliberately not among them, keeping the
default gate and validating its key "after the platform has already required a
JWT". That was wrong, and wrong in the direction that breaks partners:
`partner-api` is deployed with `verify_jwt = false`, and its own header comment
has always said `verify_jwt = FALSE, required`, because a partner presents an API
key and not a Supabase JWT. If you had deployed it with the gate on, every partner
integration would have returned 401 before reaching any of our code. Five entries
were missing altogether; they are in the file now and the reconciliation below
returns clean.

There are **22** entries, all `verify_jwt = false`, grouped by what authenticates
them instead:

| authenticated by | functions |
|---|---|
| a provider's request signature | `stripe-webhook`, `pandadoc-webhook` |
| `x-ops-secret` / `x-reminders-secret`, from `ops_secrets` | `payment-reminders`, `expiry-reminders`, `expiry-cohorts`, `renewal-notices`, `weekly-digest`, `hubspot-sync`, `ops-alert`, `commission-statements`, `partner-webhooks` |
| a partner API key the function validates | `partner-api` |
| a tokenised link the recipient was sent | `payment-page`, `payment-confirmation`, `send-password-reset`, `tenancy-correction` |
| the tenant's own session, issued by the function | `tenant-auth`, `tenant-portal` |
| the referencing provider's token | `referencing-inbound`, `referencing-callback` |
| a signed-in portal user, checked by the function, plus its own CORS preflight | `create-referral`, `invite-user` |

`create-referral` and `invite-user` are the two to look at again rather than
inherit: their source headers say `verify_jwt = true` and their deployments say
false, and they have disagreed for as long as both have existed. The file records
the deployment, because the deployment is what runs. Settle it deliberately and
fix the losing side.

### 6a. Reconcile before you deploy

Never deploy functions in bulk without checking this first. It takes a minute and
it is the difference between a safe deploy and a silent outage:

```bash
npx supabase functions list --project-ref <REF> --output json > /tmp/fns.json
python3 - <<'EOF'
import json, re
fns = json.load(open('/tmp/fns.json'))
cfg = open('supabase/config.toml').read()
declared = {m.group(1): m.group(2) == 'true' for m in re.finditer(
    r'^\[functions\.([\w-]+)\]\s*\n(?:[^\[]*?)^verify_jwt\s*=\s*(true|false)', cfg, re.M)}
bad = [(f['slug'], f['verify_jwt'], declared.get(f['slug'], True))
       for f in fns if declared.get(f['slug'], True) != f['verify_jwt']]
print('declared:', len(declared), '| mismatches:', len(bad))
for s, dep, eff in bad:
    print(f'  {s}: deployed {dep}, a deploy would set {eff}')
EOF
```

**It must print `mismatches: 0`.** A non-zero line names a function whose
deployed gate disagrees with the file, and deploying it will change its gate. Fix
the file first, or deploy that one on its own with the flag it needs.

### 6b. Deploy all of them

> **MIGRATIONS FIRST, FUNCTIONS SECOND. This release makes that mandatory, not
> just tidy.** `generateDeed` now takes a lease (`take_deed_lease`, migration
> `20261005280000`) before it will generate anything, and it **fails closed**: if
> the RPC is not there, it generates no deed and records the failure. Deploy the
> functions against a database without that migration and *every* deed stops,
> loudly. The order in section 1.3 and 3.3 already puts migrations first; this is
> the reason not to improvise.
>
> **The front end has the same shape, and worse reach.** It asks `partners` for
> `partner_kind` (`20261007600000`) at sign-in, and against a database without
> it nobody can sign in at all. See 3.5. Two fail-closed dependencies on the
> same push, in the same direction: schema, then everything that reads it.
>
> Fail-closed is the deliberate choice. A delayed deed parks as needs-attention
> after three attempts and a person fixes it in minutes. Two live signable
> guarantees for one tenancy, one of which nothing in the portal is tracking, is
> not recoverable at all.

With the reconciliation clean, the flags come from the file and no flag needs
typing:

```bash
npx supabase functions deploy --project-ref <REF>
```

Deploy **every** function, not only the ones you changed. Functions bundle
`supabase/functions/_shared/*`, so a change to one shared file makes every
function that imports it stale, and the staleness is invisible: the function keeps
answering, with old code. On 26 September, 29 of 33 functions on dev were running
code older than the repo, and the tenant payment email was stating the rent as the
fee for two days because `create-referral` had been fixed at 10:17 and deployed at
10:16.

To see what is behind before you start:

```bash
git log -1 --format=%ct -- supabase/functions/_shared    # newest shared change
# compare against updated_at in /tmp/fns.json (milliseconds)
```

### 6c. The order, and what to check after each

Deploy in this order. It is not a dependency order (functions are independent);
it is the order that lets you catch a break before it costs you a real payment.

| # | function | gate | check it answers |
|---|---|---|---|
| 1 | `tenant-auth` | false | `POST` with no body returns its own JSON error, not a platform 401 |
| 2 | `tenant-portal` | false | same |
| 3 | `payment-page` | false | `GET /functions/v1/payment-page?token=bad` returns its own "not found", not 401 |
| 4 | `create-referral` | false | `POST` with no auth returns its own `{"ok":false,...}` |
| 5 | `payment-confirmation` | false | its own error |
| 6 | `stripe-webhook` | false | unsigned `POST` returns a signature error, **not** 401. A 401 here means the gate is on and every payment will be lost |
| 7 | `pandadoc-webhook` | false | unsigned `POST` returns a signature error, not 401 |
| 8 | `send-deed-to-agent`, `send-deed-to-landlord`, `deed-download` | true | `POST` with no auth returns 401 (correct: these are staff-invoked) |
| 9 | the cron set | false | `POST` without `x-ops-secret` returns its own refusal, not 401 |
| 10 | `partner-api`, `partner-webhooks` | false | `POST` with no key returns its own error, not 401 |
| 11 | everything else | per file | it answers at all |

The distinction to watch for throughout: **a platform 401 has an empty or generic
body; our refusals are JSON we wrote.** If a function that should authenticate
itself returns a bare 401, its gate is on and the entry is missing from
`config.toml`.

After the chain is deployed, re-walk from the pay link (section 11): the payment
email, the `/pay` page, the Stripe redirect, the webhook, the deed. That walk
exercises 1 to 8 in the order a tenant hits them.

---

## 7. Secrets

Set on the project, not in the repo. Eighteen names, plus sandbox variants.

```bash
npx supabase secrets set --project-ref <ref> \
  SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  APP_URL=https://portal.opndoor.co \
  PORTAL_ENV=production \
  RESEND_API_KEY=... EMAIL_FROM=... EMAIL_REPLY_TO=... \
  OPS_ALERT_ADDRESS=... \
  STRIPE_SECRET_KEY=sk_live_... STRIPE_PUBLISHABLE_KEY=pk_live_... STRIPE_WEBHOOK_SECRET=whsec_... \
  PANDADOC_API_KEY=... PANDADOC_TEMPLATE_ID=... \
  REMINDERS_CRON_SECRET=... \
  HUBSPOT_ACCESS_TOKEN=... \
  REFERENCING_API_URL=... REFERENCING_API_EMAIL=... REFERENCING_API_PASSWORD=... REFERENCING_API_TOKEN=...
```

**`EMAIL_REVIEW_ADDRESS` must NOT be set on production.** When it is set, every
outbound email is redirected to it. That is what makes the clone safe and what
would make production silent.

**The `_TEST` suffix is not a convenience.** Sandbox reads `NAME_TEST` and
**never falls back to the live value** (`_shared/livemodeCredentials.ts`). So on
production you set the base names; on the clone you set the `_TEST` ones and a
sandbox key cannot accidentally charge a real card.

Also seed, in SQL, on each project:

```sql
-- The cron secret, read at run time by every scheduled job.
insert into public.ops_secrets (name, secret) values ('reminders_cron', '<same value as REMINDERS_CRON_SECRET>')
on conflict (name) do update set secret = excluded.secret;

-- The base URL the crons post to. Without it every cron job no-ops, deliberately.
-- Note this lives in ops_secrets too, not in a settings table: ops_functions_base_url()
-- reads `select secret from ops_secrets where name = 'functions_base_url'`.
insert into public.ops_secrets (name, secret) values ('functions_base_url', 'https://<ref>.supabase.co')
on conflict (name) do update set secret = excluded.secret;
```

That second one is the guard that stops a restored clone's crons posting at
production. **Set it last, and check it first if a clone starts doing something
alarming.**

---

## 7a. APP_URL: the address every emailed link is built on

**Walk fix 34.** Get this wrong and every invitation, password reset and
payment link in the product points somewhere the recipient cannot reach.

`APP_URL` is an Edge Function secret, and `_shared/safeOrigin.ts` prefers it
over anything the caller sends -- deliberately, so that whoever calls a
function cannot choose where a genuine Opndoor-branded email points. That
makes it the single place the live address is set, and the single place it
can be wrong.

**It was wrong on dev**, which is how this was found: `APP_URL` was
`http://localhost:5173` while the dev portal runs on `5174`, so accepting an
invitation went to a dead address. Fixed on dev on 2026-09-30.

### The cutover step

Set it to the live portal address, with no trailing slash:

```
APP_URL=https://<the live portal hostname>
```

Set it the same way as the other secrets in section 7. It is read at
invocation, so **no redeploy is needed** after changing it -- but see the
check below, because "no redeploy needed" is also why a wrong value goes
unnoticed.

### The check, before you hand back

The Management API returns secrets as a SHA-256 digest of the value, never
the value. That is enough to prove it exactly, without the value ever being
printed:

```bash
# What is set:
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/<live-ref>/secrets" \
  | python3 -c "import json,sys;print([s['value'] for s in json.load(sys.stdin) if s['name']=='APP_URL'][0])"

# What it SHOULD be:
python3 -c "import hashlib;print(hashlib.sha256(b'https://<the live portal hostname>').hexdigest())"
```

The two must be identical. If they are not, the value is not what you think
it is -- including a stray trailing slash or `http` where you meant `https`,
both of which produce a completely different digest.

### And then actually click one

Invite yourself, open the email, and click the link. The digest proves the
string; only clicking proves the address resolves, the certificate is valid,
and `/accept-invite` is served. Two different questions.

### The other half: Supabase Auth's own redirect allow-list

`APP_URL` decides what the link says. Supabase Auth decides whether it will
honour a redirect to it. In **Authentication -> URL Configuration** on the
live project:

- **Site URL** must be the live portal address.
- **Redirect URLs** must include `https://<the live portal hostname>/**`.

On dev the allow-list still carries `localhost:3000`, `:5173` and `:5174`,
which is right for dev and must NOT be copied to production.

**And Site URL is not cosmetic, which is the part worth knowing.** It is the
FALLBACK GoTrue uses whenever a link is generated with no `redirect_to`, or
with one the allow-list refuses. Measured on dev on 2026-09-30: Site URL was
`http://localhost:3000`, a port nothing runs on, so any link that lost its
`redirect_to` for any reason landed nowhere -- silently, because the link
itself looks perfectly normal. Set to `http://localhost:5174` on dev the same
day.

So there are two ways an invitation can point at a dead address and only one
of them is `APP_URL`. Check both.

### The check for this half

```bash
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/<live-ref>/config/auth" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('site_url =',d['site_url']);print('allow    =',d['uri_allow_list'])"
```

`site_url` must be the live portal address and the allow list must contain
it. Unlike the secrets endpoint this returns the real value, so you can read
it directly.

**Then prove it end to end, without sending anybody an email.** The admin
`generate_link` endpoint returns a link without delivering it:

```bash
curl -s -X POST "https://<live-ref>.supabase.co/auth/v1/admin/generate_link?redirect_to=https%3A%2F%2F<host>%2Faccept-invite" \
  -H "apikey: $SERVICE_ROLE" -H "Authorization: Bearer $SERVICE_ROLE" \
  -H "Content-Type: application/json" \
  -d '{"type":"recovery","email":"<your own address>"}' \
  | python3 -c "import json,sys,urllib.parse;l=json.load(sys.stdin)['action_link'];print(urllib.parse.parse_qs(urllib.parse.urlparse(l).query)['redirect_to'])"
```

It must print your live `/accept-invite` address. If it prints the Site URL
instead, the allow-list does not contain what you asked for.

**One trap, found doing exactly this on dev.** `redirect_to` must be a QUERY
PARAMETER on that endpoint. Passed inside the JSON body as
`options.redirect_to` it is accepted, ignored, and silently replaced with the
Site URL -- which reads as "the allow-list is wrong" when nothing is wrong at
all. The supabase-js client sends it correctly; a hand-written curl is where
this bites.

---

## 8. Crons

Sixteen jobs after this branch, thirteen of which already exist on production.

```sql
select jobname, schedule, active from cron.job order by jobname;
```

| job | schedule (UTC) | why two |
|---|---|---|
| `expiry-cohorts-0700` / `-0800` | `0 7,8 * * *` | pg_cron is UTC, London is not. One of the pair is always 08:00 London; the function self-gates and the off-hour run no-ops. |
| `expiry-reminders-0700` / `-0800` | `0 7,8 * * *` | same |
| `payment-reminders-0700` / `-0800` | `0 7,8 * * *` | same |
| `renewal-notices-0700` / `-0800` | `0 7,8 * * *` | same |
| `weekly-digest-0700` / `-0800` | `0 7,8 * * 1` | same, Mondays |
| **`commission-statements-0700` / `-0800`** | `0 7,8 * * *` | **NEW.** Daily, and the FUNCTION decides whether today is the send day. |
| **`deed-sweep-hourly`** | `20 * * * *` | **NEW.** Hourly, not a pair: there is no London hour to hit, only how long a paid tenant may wait without a deed. |
| `hubspot-sync` | `*/2 * * * *` | |
| `partner-webhooks` | `* * * * *` | |
| `rate-limit-cleanup` | `7 * * * *` | |

**The pairs are deliberate and are not to be tidied away.** `CUTOVER.md` records
the same decision in the same words: the database runs in UTC, the second job
covers British Summer Time, both fire, and the ledger makes the second a no-op.
I checked that claim rather than taking it on trust: `fire_payment_reminders`
claims into `payment_reminders` with `on conflict do nothing` and skips when the
insert finds nothing, so a second run the same day returns no rows and sends no
email. Asserted in `supabase/tests/pay_link_outlives_a_day.test.sql`. If you find
yourself about to delete one of a pair, read this paragraph again.

### 7.9 EVERY MIGRATION IN THIS BATCH, IN APPLY ORDER

They apply in filename order, so this is the order they run. The count and the
list are what to diff against `supabase_migrations.schema_migrations` on the
clone if anything looks wrong; the authoritative count is always the
`ls | wc -l` in 1.4, never this prose.

| # | migration | what it changes |
|---|---|---|
| 1 | `20261006089000_make_manager_has_never_worked` | `admin_update_user_role` wrote seven columns that did not exist; Make Manager had never worked |
| 2 | `20261006090000_the_level_ladder` | Director / Manager / Negotiator as ranks, `may_act_on_user`, `assert_may_grant_level` |
| 3 | `20261006091000_every_person_control_respects_the_ladder` | eight person controls gated, plus the `users_level_ladder_guard` trigger |
| 4 | `20261006100000_a_paid_application_with_no_deed_is_found` | `deeds_awaiting_generation` |
| 5 | `20261006101000_deed_sweep_cron` | the hourly deed sweep at `:20`. **Inert unless `functions_base_url` is set (see 8.1).** |
| 6 | `20261006110000_commission_is_apportioned_not_rounded_twice` | commission apportioned to the penny; re-freezes affected rows |
| 7 | `20261006120000_a_fee_basis_has_a_unit` | Weeks / Months on a fee basis. **Rewrites seven pricing functions; watch this one in the rehearsal.** |
| 8 | `20261006130000_replay_what_the_missing_map_skipped` | winds the HubSpot cursor back for partners whose events drained without an association |
| 9 | `20261006140000_health_tells_you_what_to_do` | `cron_health` gains per-job attribution and the base URL; drops `needs_attention` |
| 10 | `20261006150000_a_manager_may_not_edit_another_agency` | scopes `users_mgmt_update`; adds `receives_notifications`, its RPC and its trigger guard |
| 11 | `20261006160000_the_deed_goes_to_whoever_sent_the_referral` | the deed goes to the referrer; drops the nominated override; fixes the direct rail |
| 12 | `20261006170000_an_agency_is_the_boundary_not_the_partner` | **the riskiest one.** Rescopes the three `applications` policies from partner to agency |
| 13 | `20261006180000_the_resend_follows_the_same_rule_and_reminders_fire` | manual Resend uses the one resolver; `fire_expiry_reminders` stops writing a column that never existed |
| 14 | `20261006190000_a_cron_email_is_scoped_to_the_reader` | `staff_notification_scopes`: a scheduled email's recipients per reader |
| 15 | `20261006200000_a_scheduled_send_is_ledgered_per_reader` | `user_id` on the digest and cohort ledgers |
| 16 | `20261006210000_the_weekly_digest_counts_one_agency` | `agency_weekly_digest`, so the digest's figures are one agency's |

Numbers 10 to 16 are the batch that changes who receives and who can see. If
you want the smallest possible cutover, 1 to 9 stand on their own and 10 to 16
can follow after a rehearsal; nothing in 1 to 9 depends on them.

### 8.0 WHAT CHANGED IN THIS BATCH THAT YOU MUST VERIFY AFTER CUTOVER

Seven migrations in this batch change who receives things and who can see
things. Two are worth a deliberate check on the clone before you believe the
rest.

**20261006170000 is the riskiest migration on this branch.** It rescopes
`applications_select`, `applications_update` and `applications_insert` from the
partner to the AGENCY, because every agency shares the `opndoor-agents` house
partner. Get it wrong in one direction and an agency sees nothing; in the other
and they see each other. On the clone, sign in as one agency's Director and
confirm they see their own applications and only their own:

```sql
-- As that Director's session, through the app rather than psql.
-- Or in psql, impersonating: set the JWT claims and `set local role authenticated`.
select count(*), count(distinct agency_id) from public.applications;
```

One agency, and a count that matches what that agency has sent. If it returns
zero, the person has no `user_scopes` row: give them a position. An
unpositioned management user now reaches nothing, deliberately, because the
old fallback was "the whole partner".

**The three scheduled emails are now per reader.** `weekly-digest`,
`expiry-cohorts` and `expiry-reminders` resolved recipients as every management
user on the partner and built their content the same way, so on the house route
each agency received the others' figures, and the cohort CSV carried the
others' tenants. After the push, the first Monday digest should show one
agency's numbers to that agency. `partner_digest_sends` and
`expiry_cohort_sends` gained a `user_id`; rows with a null `user_id` are
pre-cutover partner-level sends and are expected.

**Expiry reminders start working for the first time.** `fire_expiry_reminders`
wrote to a column that has never existed and only ever inside its loop body, so
it was silent every day nothing was due and would have thrown `42703` the first
day something was. Expect reminder emails to begin, and
`public.expiry_reminders` to start filling.

### 8.05 HUBSPOT: THE TOKEN, AND SUCCESSES ON THE HEALTH PAGE

`hubspot-sync` answers `{"ok":false,"error":"No HubSpot access token
configured."}` when its secret is missing, and does so on every run: on dev
that is currently 68 failures out of 211 calls in 24 hours. It is a secret gap
rather than a code fault, and it is invisible unless somebody reads the
response body, which is why the Health page now does.

**After the push, in this order:**

1. Confirm the secret is set on production (`HUBSPOT_ACCESS_TOKEN`, or whatever
   the project names it in Edge Function secrets). The function reads it at
   call time, so setting it needs no redeploy.
2. Open `/health` as an Opndoor admin and find `hubspot-sync` under Recent
   responses. It groups by job now, so it will not be buried under
   `partner-webhooks`.
3. The latest response for that job must be a **2xx**. A 500 whose body names
   the token means step 1 did not take.
4. Then check the replay from `20261006130000` landed: section 14.2 has the
   before/after cursor queries and the expected notice.

**What "working" looks like:** `hubspot-sync` showing recent 2xx responses and
an error count of zero over the window, beside `partner-webhooks` doing the
same. Any other job showing errors is read the same way: the page states what
each failure means and what to do about it.

#### 8.05a HUBSPOT HAS NEVER RUN END TO END. NOT ONCE.

**Read this before trusting anything above.** Measured on dev, 2026-10-03:

| fact | value |
|---|---|
| `ops_secrets.hubspot_access_token` | **does not exist, and never has** |
| `hubspot_disabled` | `'true'`, set 28 Sep 16:41 |
| partners marked stuck (`stuck_error`) | none, all eleven |
| the cron | active, every 2 minutes, 1,440 successes in 2 days |

So **no record has ever been written to HubSpot from this codebase**. The
sync's happy path -- resolving a company, creating an applicant object,
associating the two, advancing a pipeline stage -- has been read and
reviewed and never executed. Everything in 8.05 above tells you how to
see that it is RUNNING; none of it tells you it WORKS, because nothing
here could.

That is not a reason to delay the cutover: HubSpot is a reporting
integration and no tenant, agent or payment depends on it. It is a
reason not to tick it off on the strength of a 2xx.

**Do this once, on live, before you hand back:**

1. **Confirm the token is set.**

   ```sql
   select name, (secret is not null and secret <> '') as is_set
     from public.ops_secrets
    where name = 'hubspot_access_token';
   ```

   Empty result or `is_set = false` means the sync will do nothing. It
   may instead be set as an edge-function env var, which the function
   also reads; the Edge Functions secrets page is the other place to
   look.

   - [ ] a token is set, in one of the two places

2. **Confirm the sync is NOT disabled.**

   ```sql
   select secret from public.ops_secrets where name = 'hubspot_disabled';
   ```

   **Production should have no such row.** If it returns `true`, the
   function returns early and syncs nothing, exactly as dev has been
   doing since 28 September. Dev carries the row deliberately; a clone
   taken from production will not, unless somebody adds it.

   - [ ] no `hubspot_disabled` row, or it is not `true`

3. **Sync one company and look at it in HubSpot.** This is the step that
   has never been done. Pick one real agency, let the cron run (it is
   every two minutes), then open HubSpot and find that company by name.

   - [ ] the company is in HubSpot
   - [ ] its properties are the ones the field map says, not blanks
   - [ ] a second run does not create a duplicate of it

4. **Then check the alerting is quiet rather than broken.** Since
   `20261007740000` the same failure alerts once and not once an hour.
   A silent `hubspot_sync_error:config` therefore no longer proves the
   token is fine -- it may mean it was reported yesterday and latched.

   ```sql
   select alert_type, detail, first_at, last_at
     from public.ops_alert_state
    where alert_type like 'hubspot%';
   ```

   An empty result is the good answer. A row means the sync is failing
   and has already said so once.

   - [ ] no row, or Matt has seen what it says

**Stop and tell Matt** if step 3 cannot be completed. A HubSpot integration
that has never moved a record is not a thing to declare working.

### 8.1 VERIFY THE BASE URL BEFORE YOU TRUST ANY CRON

Four of these jobs end their command with

```sql
... where public.ops_functions_base_url() is not null;
```

so if that function returns null the job **runs on schedule, succeeds, and does
nothing**. `cron.job_run_details` shows "succeeded" every time, because the job's
work is a `select` that matched no rows. There is no error anywhere to find.

**The four that go silent:**

| job | what stops |
|---|---|
| `commission-statements-0700` / `-0800` | the monthly statement emails |
| `hubspot-sync` | the whole CRM sync |
| `deed-sweep-hourly` | the safety net that generates a deed for a paid application that never got one |

The other jobs are unaffected because they carry the URL as a literal, which is
the thing `20260811210000` warns about: a literal survives every later
correction. That is why these four read it at run time instead, and why it has
to be right.

**THE HEALTH PAGE NOW LEADS WITH THIS**, so you can check it without a psql
prompt. `/health` reads the setting and, when it is missing, opens with a red
banner naming the jobs that are reporting success while making no call, and the
one thing to do about it. Each job row also says whether its command depends on
the base URL, read off the command text rather than a list, so a job that gains
or loses the guard describes itself correctly.

While you are on that page: it is machinery only now, for whoever runs the
deployment. The human work queue that used to sit on it ("Needs attention") is
on Home, where the person clearing it is. Every failing row carries one line of
what it means and one of what to do, naming the secret, the function or the
application, and a row with nothing to act on is no longer drawn in red.

Recent responses are grouped by job. Read the attribution with one caveat, which
the page states: pg_net throws away the request URL when the response lands, so
a response is matched to the job whose run window contains it. Two jobs firing
in the same second can be attributed to each other. It is right about which job
is failing and can be wrong about which of two simultaneous jobs a single row
belongs to.

**This is a VERIFY step, not a setting.** Production has an
`ops_secrets.functions_base_url` row already. The failure mode is that it is
empty or points somewhere else, which is exactly what dev was: empty, with four
crons quietly idle. Run this after the push, before you believe any cron result:

```sql
-- Must return the PRODUCTION functions URL, not null and not another project.
select public.ops_functions_base_url() as base_url;

-- And the row behind it, so you can see whether it is missing or just blank.
select name, secret is not null and secret <> '' as is_set
  from public.ops_secrets order by name;
```

Expected: `https://xogpsaoyprgmxdkmcype.supabase.co`, and `is_set` true for both
`functions_base_url` and `reminders_cron`.

If it is null or wrong, set it and re-check before moving on:

```sql
update public.ops_secrets
   set secret = 'https://xogpsaoyprgmxdkmcype.supabase.co'
 where name = 'functions_base_url';
```

Until that query returns the production URL, a green `cron.job_run_details` for
any of those four jobs means nothing.

**Why the statements cron is daily and not monthly:** the send day is the 1st, or
the next day that is not a UK bank holiday. That cannot be written as a cron
expression, and `0 7 1 * *` would silently skip any month whose 1st is a bank
holiday. The cheap daily wake-up that almost always answers "not the send day" is
the honest implementation.

---

## 8a. Settings that live nowhere but the dashboard

Matt asked for these listed, and the reason is the one thing they have in
common: **none of them is in a migration**, so `npm run drift` cannot see
them, they leave no trace in git, and a clone made from a database backup
does not necessarily carry them. Every one has to be set by hand on
production and checked by eye.

| setting | where | how you know it is wrong |
| --- | --- | --- |
| **`hubspot_sync_env.is_active`** | a boolean UPDATE, by hand | The HubSpot sync does nothing, silently. There is no migration that flips it and nothing reports that it is off. Found while writing `docs/HUBSPOT-CONSEQUENCES.md`; it is the single most invisible switch in the system. |
| **Edge function secrets** | Dashboard → Edge Functions → Secrets, or `supabase secrets set` | Section 7 lists every one. A missing secret usually shows as a function erroring, but two of them fail SILENTLY: see below. |
| **`ops_secrets.functions_base_url`** | a row in the database, not a settings table | Every cron becomes inert. Nothing errors, nothing is logged, the jobs simply post nowhere. Section 8.1. |
| **`ops_secrets.reminders_cron`** | a row in the database | The crons are refused by the functions they call, one alert per run. |
| **MFA enforcement** | Dashboard → Authentication | Not a portal setting at all. The product requires AAL2 throughout and 27 tables now carry a restrictive policy that denies at AAL1, so if enrolment is not enforced a user can reach a signed-in state that sees almost nothing and reads as broken. |
| **Auth redirect URLs and email templates** | Dashboard → Authentication → URL Configuration | Invitations and password resets land on the wrong host, or nowhere. |
| **Storage bucket names and their policies** | Dashboard → Storage | The deed PDFs. `deed-download` signs a path inside the application's own folder and refuses anything else, so a wrong bucket is a 404 rather than a leak. |
| **Stripe keys, live vs test** | Edge function secrets | `_shared/livemodeCredentials.ts` is the only file that chooses between them, and a sandbox application must never reach the live key. |
| **PandaDoc template and webhook** | PandaDoc, plus the webhook URL | Deeds stop generating, or generate against the wrong template. |

**The check that catches most of these at once** is the Health screen after
deploy: it names the failing job and what to do about it, rather than showing
a red dot. If Health is clean and `hubspot-sync` shows successes, the crons,
the base URL and the ops secret are all right.

---

## 9. Webhooks

Three inbound, all pointed at the project by hand in a third-party dashboard.
**These are the things most often forgotten on a new project**, and each fails
silently rather than loudly.

| provider | URL | events | secret |
|---|---|---|---|
| **Stripe** | `https://<ref>.supabase.co/functions/v1/stripe-webhook` | `checkout.session.completed`, `charge.refunded` | `STRIPE_WEBHOOK_SECRET`, per mode |
| **PandaDoc** | `https://<ref>.supabase.co/functions/v1/pandadoc-webhook` | `document_state_changed` (at least `document.completed`, `document.viewed`) | shared secret in the URL query, see the function |
| **Referencing provider** | `https://<ref>.supabase.co/functions/v1/referencing-callback` | provider's verdict callback | `REFERENCING_API_TOKEN` |

Stripe keeps **separate endpoint lists per mode**. A test-mode endpoint on the
clone and a live-mode endpoint on production are two different registrations with
two different signing secrets, and configuring one does not configure the other.

**After Regent's first live referral, check** that the Stripe endpoint shows a
2xx for it. A silently failing webhook looks exactly like a tenant who has not
paid.

---

## 10. PandaDoc template

The template is not in the repo; it lives in the PandaDoc workspace and is
referenced by `PANDADOC_TEMPLATE_ID`. Full build instructions are in
`supabase/DEEDS-TESTING.md` section 3.

### THE TEMPLATE DOES NOT CHANGE FOR THIS RELEASE. No action for Balal.

Ruling, 27 September. Each tenant signs their **own** deed, for their own share,
**naming all the tenants**. The share is recorded on the application and on the
bordereau, **not in the document**. So a joint tenant's deed renders exactly as a
single tenant's does, from the same six merge tokens:

| token | value |
|---|---|
| `reference_number` | The guarantee reference, one per deed |
| `tenant_name` | Every tenant on the tenancy, comma separated. On a tenancy of one, that one person |
| `tenancy_start_date` | dd/mm/yyyy |
| `rental_address` | Title-cased, postcode raw |
| `agent_email` | Where the executed deed is delivered |
| `issue_date` | Generation date, Europe/London, server-side, never recipient-editable |

An earlier draft of this branch sent two extra tokens on joint tenancies,
`guaranteed_amount` and `co_tenant_names`, and this section used to ask for a
template change to render them. **Both have been removed from the code.** They
needed the template change to render at all, and an unsupplied PandaDoc token
renders empty without removing the sentence around it, so shipping them against
today's template would have printed a deed reading "in respect of  per calendar
month": an amount the deed appears to state and does not. On a financial
instrument that is worse than not stating it.

The only thing a joint deed says differently is `tenant_name`, which lists every
tenant so the document says which tenancy it belongs to. That needs no template
work, because the token already exists and already prints there.

**Still one signer role.** Opndoor's signature is a static facsimile image, not a
second recipient. One consequence to flag to Matt: PandaDoc's `document.completed`
signs and executes in one step, so **"signed" and "executed" are the same event**
and no screen can show them apart. If Opndoor is to countersign each deed for
real, the template needs a second signer role and the webhook needs to key on
recipient-level completion.

### 10.1 The deed-chain alerts, and what each one means

These arrive by email through `ops-alert` and are also rows in `public.ops_alerts`,
deduped to one per type per hour. Read them here:

```sql
select hour_bucket, alert_type, detail from public.ops_alerts
 order by hour_bucket desc limit 50;
```

**Raise them only through `public.report_ops_incident(type, detail)`.** Never
insert into `ops_alerts` directly: `hour_bucket` is `not null` with no default, so
a direct insert fails, and the call sites wrote `.then(() => {}, () => {})` around
it, which swallowed the error. Three alerts had therefore never been raised once
in their lives (`stripe_livemode_mismatch`, `pandadoc_livemode_mismatch`,
`hubspot_map_drift`), which is fixed on this branch. Verified by running the
insert as it stood against dev: zero rows written.

| alert | what happened | what to do |
|---|---|---|
| `deed_generation_failed` | Generation failed for one application. The row keeps the reason and retries; three consecutive failures park it as needs-attention | Usually per-application. If many arrive at once, suspect `PANDADOC_API_KEY` or `PANDADOC_TEMPLATE_ID` |
| `deed_no_delivery_contact` | Paid, but nothing resolves as a delivery contact, so no deed was generated | Add the branch contact, or activate a person at the agency, then press Generate on the application |
| `deed_pdf_unavailable` | The tenant signed, but the executed PDF could not be downloaded from PandaDoc. The deed is **not** executed and PandaDoc will redeliver | Expect this to clear itself within minutes: PandaDoc renders the PDF after it fires the callback. If it repeats for over an hour, the PDF is not being rendered and the deed needs executing by hand |
| `deed_pdf_not_stored` | The PDF downloaded but Storage refused it. Not executed; PandaDoc will redeliver | Check the `deeds` bucket exists and the service key can write it |
| `deed_orphan_document` | A document was created at PandaDoc but the send failed, and we could not void it | Void the named document id in PandaDoc. The application generates a fresh deed on retry |
| `deed_stamp_partial` | The document id was recorded but the surrounding deed columns were not. Signing works; the status may read stale | Correct the row at leisure. Nothing is lost |
| `deed_document_unattached` | The worst one. A deed was sent but the row could not be stamped even with the id alone, so nothing can match the signature. The document is voided automatically where possible | If the alert says the void also failed, void the named id in PandaDoc by hand |
| `deed_awaiting_staff_send` | The deed is executed but there is nobody to deliver it to | Nominate a recipient or activate a manager, then use Send deed to agent |
| `deed_delivery_target_unreadable` | The deed is executed but resolving where to send it failed, so it is queued | Use Send deed to agent once the database is answering |
| `deed_executed_after_refund` | A completion arrived for a refunded application. The deed was refused and not issued | Void the named document in PandaDoc |
| `pandadoc_completed_unknown_document` | A completion matched no application | Either a superseded document (benign) or this project's shared key is verifying **another environment's** callbacks, which means that environment's deeds are not being executed. Check which |
| `pandadoc_livemode_mismatch` | A callback's mode does not match the application it names | A sandbox event replayed against a live application, or one shared key configured for both modes. Neither is fixed by choosing one |

---

## 10.2 HubSpot: the fault, and the fix that is already on this branch

> **Correcting an earlier draft of this section.** It told you to check
> `hubspot_partner_map` for unmapped partners and insert portal ids by hand. That
> described the state before `20261005250000`, which is ON this branch, and it
> named a column (`portal_id`) the table does not have. Verified on dev while
> walking onboarding: every partner is mapped, including one created through the
> Suppliers page minutes earlier. There is no by-hand step here.

The sync needs two facts per partner and they used to be created by different
things, which was the whole of the problem.

| table | what it is | created by |
|---|---|---|
| `hubspot_sync_cursor_partner` | how far the sync has got | a trigger, since 20260812030000 |
| `hubspot_partner_map` | the partner's CRM mapping | a trigger, **since 20261005250000** |

**THE FAULT, as it was.** Seven partners held cursors and `hubspot_partner_map`
was empty: the August migration seeded the cursor and nothing seeded the map. So
the sync ran every two minutes, found a cursor, looked for a mapping, found none
and wrote nothing, while `cron.job_run_details` reported "succeeded" throughout,
because the cron's job is to POST and the POST returned 200.

**THE FIX, on this branch.** `20261005250000` backfills every existing partner
and adds an AFTER INSERT trigger mirroring the cursor trigger, so the two facts
are created together and cannot drift apart again. AFTER INSERT rather than
BEFORE, so a failure wiring the CRM cannot abort the creation of the partner
itself.

**What to check on the clone**, after the migrations, using the columns that
exist:

```sql
select p.slug, m.partner_id is not null as mapped, m.active
  from public.partners p
  left join public.hubspot_partner_map m on m.partner_id = p.id
 order by mapped, p.slug;
```

Every row should say mapped. If any does not, the backfill in `20261005250000`
did not run and you are missing that migration, which is a different problem
from the one this section used to describe.

**THE SILENT FAILURE THAT REMAINS IS HUBSPOT'S OWN.** It ACCEPTS a write to a
property that does not exist and discards it, returning 200. So a mapped,
running, apparently healthy sync can be writing nothing. `hubspot-sync` checks
the property list and raises `hubspot_map_drift` when a mapped property is
missing, which is the canary for exactly that. **That alert had never fired in
its life**, because it was raised by a direct insert into `ops_alerts` and
`hour_bucket` is `not null` with no default, so the insert failed every time and
the error was swallowed. Fixed on this branch; see 10.1.

**`hubspot_sync_events` being empty on dev is normal** and always has been: dev
has no HubSpot token, so there is nothing to record. The first proven sync
anywhere will be the one on your clone, which is why 14.2 walks it.

---

## 11. The walks

### 11.1 On the clone

`scratchpad/walk/SUNDAY-WALK.md`, 1,396 lines, two complete journeys step by
step with the exact figures to expect at each screen.

Read its **"READ THIS BEFORE YOU BOOK THE TIME"** section first. It lists five
blockers found while writing it.

**Three of those five have since been fixed, and the walk script has not been
updated.** Do not spend time on them:

| blocker | status now |
|---|---|
| **A**, the working tree does not compile | **Fixed.** `npm run typecheck` and `npm run build` are clean, and 567 tests pass. |
| **C**, the commission rate for Regent | **Fixed.** Their deal is a pricing agreement, created by the keying script in section 4, and verified by its own rows 5 to 8. |
| **D**, the tenant is shown one number and charged another | **Fixed.** The payment page built its displayed fee from `monthly_rent` while charging `fee_amount`: a tenant was shown £2,400 under the words "One month's rent" and charged £1,661.54. Both now read the fee, on all four surfaces. |

The two that still stand, and you will hit both:

- **Blocker B, Stripe will refuse on any new project ref.** A new project needs
  its own Stripe test webhook registered before any payment step works.
- **Blocker E, MFA.** Nobody walks anything without an authenticator app. Set it
  up before you sit down, not during.

Then:

- **Walk 1, Rightmove, exactly as today.** This is the regression test that
  matters: a supplier referral must behave on the clone exactly as it behaves on
  production now. If anything differs, stop.
- **Walk 2, Regent.** The new shape: pre-referenced, straight to payment, the
  three-week fee, the 20% agreement, joint tenancies.

`EMAIL_REVIEW_ADDRESS` must be set on the clone for both.

#### Rightmove's rail, which decides which email their tenants get

Matt, 2026-10-04. Two checks, and they are one question asked at both ends.

**1. `refers_own_stock` must be FALSE for Rightmove on live.**

```sql
select slug, name, partner_kind, refers_own_stock
  from public.partners where partner_kind = 'supplier';
```

It is `false` for every supplier except one on dev, and Kestrel's `true` was
set to `false` on 2026-10-04 to match how Rightmove is configured. The column
means ownership only: true for a party referring stock it manages itself,
false for one referring on behalf of agencies it does not own, which is what
a supplier is.

**2. A Rightmove referral's tenant email must be the SUPPLIER wording.**

This is what the flag decides, which is why it is worth checking rather than
assuming. `create-referral` picks the rail from it, and the rail picks the
opening sentence:

| `refers_own_stock` | rail | the tenant reads |
|---|---|---|
| false | `supplier` | "opndoor is acting as guarantor for your tenancy at ADDRESS. The last step is the guarantee fee." |
| true | `agency` | "AGENCY has arranged an opndoor guarantee for your tenancy at ADDRESS. To put it in place, ..." |

The first is the approved supplier wording. The second names the agency and
is for a pre-referenced AGENCY referral, where the agency made the decision
and opndoor took no view.

**So a `true` on live would put Rightmove's tenants on the agency email**,
which names a company and asserts that company arranged the guarantee. Send
one sandbox referral through Rightmove and read the opening line of the
tenant's email; it must be the first row of that table.

#### Rightmove's agencies must inherit Rightmove's checking setting

Matt, 2026-10-04, after a Kestrel referral sent its tenant opndoor's full
application email under an arrangement where opndoor checks nothing.

`agencies.referencing_mode` was NOT NULL DEFAULT 'opndoor_referenced', so
every agency always had its own opinion and `resolve_referencing_mode`'s
inheritance arm was unreachable. 20261008050000 drops the default, allows
null, and sets every agency in a supplier estate to inherit EXCEPT any whose
audit trail records a deliberate change.

**After migrating the clone, both of these:**

```sql
-- 1. Every Rightmove agency inherits. Expect no rows.
select a.name, a.referencing_mode
  from public.agencies a join public.partners p on p.id = a.partner_id
 where p.partner_kind = 'supplier' and a.referencing_mode is not null;
```

Any row that DOES come back is an agency whose setting somebody changed on
purpose; the migration spared it and said so in a NOTICE as it applied. Read
that notice in the apply output and check each one is intended rather than
assuming the empty result.

**2. Send a test Rightmove referral and watch where the tenant lands.** It
must go STRAIGHT TO PAYMENT, with no application form and no request for
address history, income or documents. That is the behaviour the SQL above
only predicts.

### 11.2 On production, after the cutover

A short confidence walk, not the full 1,396 lines. In order:

1. **Sign in as yourself.** The portal loads, the dashboard has its usual
   numbers. Compare the headline figures to a screenshot taken before the push.
2. **Open three existing applications** at different statuses: one Sent, one
   Paid, one Deed Issued. Each renders, the money is unchanged, the timeline runs
   forwards.
3. **Download one export** and compare it to one taken before the push. Fee
   columns now carry pence and the fee, not the rent; everything else matches.
4. **Run the Regent keying script** (section 4) and read its ten rows.
5. **Invite Rosa** from the portal, and have her accept. Check verification row
   10 turns true.
6. **As Rosa, send one real Regent referral** for a real tenancy. Watch:
   - the fee preview appears once she enters the rent, showing 3 weeks
   - the tenant gets a payment link with no eligibility form
   - Stripe shows a 2xx on the webhook
   - the deed generates and delivers to Rosa
7. **Check the Applications list as Rosa.** No Route column, no Agency column, no
   Branch column, and the Delivery failed filter is empty.

Stop at any step that does not match and tell Matt before continuing.

---

## 12. What is not done, and what to watch after you go live

This section is yours, not a status report: everything in it is either
something you will have to do or something that will look like a fault and
is not.

**Not done:**

- **UK bank holidays are a static table** in the function, covering 2026 to 2030.
  It must be extended before it runs out. There is a guard that treats an unknown
  year as all-working-days rather than failing silently, but that is a fallback,
  not a plan.
- **Bounces are not detected.** "Delivery failed" currently means the email
  provider refused the send. There is no bounce webhook anywhere in the tree. The
  columns are shaped to receive one.

**Watch:**

- **`partner_weekly_climbers`** still ranks referrers by summed `monthly_rent`
  and feeds the "Climber of the week" line of the digest. Same defect as the two
  aggregates fixed in bite 4, not fixed.
- **The demo agency "Hartwell Estates"** appears in mock data and so in demo-mode
  exports. Cosmetic, but it is a name on a screen.

---

## 12a. After launch: what is recorded and not built, 2026-10-05

**THE STATE OF THE BRANCH YOU HAVE BEEN HANDED.** Measured on the tip
commit of `matt-fixes`, not remembered. The figures in brackets are the
same gate on `partner-api` at `4a39fe6`, which is where the second night
run started:

| gate | result on `matt-fixes` | on `4a39fe6` |
| --- | --- | --- |
| `npm run drift` | clean. 488 migrations; dev matches a clean apply | clean |
| `npm run typecheck` | clean | clean |
| `npm run build` | clean | not run |
| `npm test` | **348 files, 3,814 tests, 0 failing** | 333 files, 3,648 tests |
| `npm run test:db` (pgTAP, against dev, two batches) | **144 files, 0 failing assertions, 0 errored** | 135 files, 0 failing |

**What moved in the suite, rather than the total.** Across all three
runs on this branch: 15 new vitest files and 9 new pgTAP files; 28 new
cases inside seven existing vitest files; nothing removed; three
existing cases renamed, all three because Matt changed the rule they
pinned (two in `theGuidesSayItPlainly`, one in `noRatesInTheGuides`,
where "usually one month's rent" stopped being the answer). Eight new
migrations, none of them a correction to an earlier one.

**And two assertions that had been passing on nothing**, both found by
probing rather than by failing: "re-choosing the same supplier clears
nothing" compared '' to '' because `sel(v, 'Agency')` finds no
`<select>` since the agency picker became a type-ahead, and the
Expiries rule itself was never tested because every run is in mock
mode, where the helper returns its fallback before reading a book.

Run all four yourself on the clone before you touch production; that is
what section 1.1b is for. A green suite here is evidence about DEV, and
the clone is the only place it becomes evidence about live.

Everything below is in `docs/QUEUE.md` verbatim under the letter given.
None of it blocks Wednesday; all of it was reported by Matt after the
go-live branch was cut, and it is here so nothing is carried only in
somebody's head.

### Scale: the sign-in load, and the fix Matt has chosen

**(dg) The sign-in load.** The pickers now search on the server
(`search_agencies_for_referral`), so the referral form no longer
depends on the whole book. But `src/lib/hydrate.ts:171` and `:175`
still select EVERY agency and EVERY branch the caller's RLS allows,
with no limit, at sign-in. It has NOT been capped, deliberately: that
array also feeds Reporting, the League, the exports and the league
grouping, so a blanket `.limit()` would not make those slow, it would
make them WRONG, silently. Wrong money is worse than a slow form.

**MATT'S DECISION, 2026-10-05: OPTION 1. Load the org tree on demand
per screen, not at sign-in.** That is the largest of the three options
in QUEUE.md under (dg) and the only one that is correct rather than
defensive: the alternatives either keep the global load and guard
against truncation with a banner, or accept it on a head-count nobody
has measured. Nothing is to be capped in the meantime -- a `.limit()`
on that array is the silent-wrong-money failure above, and it is not
the chosen fix.

**IT STAYS AFTER LAUNCH.** The decision settles WHICH fix, not when:
it does not ship for Wednesday, and Matt's "leave the whole-book
sign-in load in After launch" stands.

`orgService.ts` also persists that whole array to localStorage on every
write, and `saveJSON` swallows a quota failure; at thousands of
agencies that is a silent failure on every on-the-fly create. The
on-demand rewrite is where that gets fixed too, because there is then
no whole array to persist.

**AND THE SAME QUESTION DECIDES A SECOND THING, measured 2026-10-05.**
The reconciliation duplicate check (ck) compares each pending agency
against every agency in the same estate: name equality, then
containment, then a trigram similarity, then a shared contact email.
Those run per candidate. On dev, with 18 agencies and 6 rows pending,
`reconciliation_queue()` returns in **28 ms**. At a few hundred
agencies it stays comfortable. At several thousand it is thousands of
comparisons per pending row, on a screen an admin opens on purpose
rather than on sign-in, and the shape to change then is the candidate
SET -- find the email matches by a join on `agent_contacts` and union
them with the name matches, instead of testing every candidate.

Not changed now, deliberately, and for the same reason the whole-book
load was not capped: the number nobody has measured is how many
agencies Rightmove will have. The fix is clear when it is needed and
would be guesswork before.

### Help and the documents

Most of Matt's review list is DONE and is listed here only so nobody
re-does it: (dr1) the Referrer guide now describes all three routes
and its status table admits Awaiting decision exists; (dr2) who sees
commission is pinned for all eight readers; (dr3) the carved-share
lines are explained in the portal's own words; (dr4) only suppliers
are told they can add an agency while referring; (dr5) the referral
checklist is a checklist; (dr6) and (dr9) were defects in the
exporter, not the product; (dr7) one answer per question; (dt)/(du)
the GBP 20 copy and the refund lines.

**STILL OPEN, and these are the ones to pick up:**

**(ds) DONE.** Both the Agent one-pager and the Sales and
conversation guide are now HTML in the management-guide template, so
every item in Help opens the same way and nothing drops into the
browser's PDF viewer. Both were read from RENDERED PAGES, not
extracted text, and every figure was cross-checked against the render
and against the landlord guide.

**If you ever need to read a shipped PDF, do it the same way.** Both
used subset fonts, so extraction returns `(a)(a)(a)` or, worse,
most of the words with the DIGITS CORRUPTED -- it rendered the
GBP 120,000 cap as "GBP 12f,fff". Never transcribe a figure from an
extraction. Render and read:

    osascript -l JavaScript scripts/render-pdf-pages.js \
      public/help-docs/<file>.pdf /tmp/pages tag

The source PDFs are gone, 2026-10-05, on Matt's word: all four of them,
1.3 MB, referenced by nothing and two of them still saying the
guarantee fee is one month's rent.

**(dj) DONE.** Both Dev Centre tabs open with the journey the
reader's ORGANISATION gets: statuses in order, the webhook events
they will receive, and the trap specific to that setting. The other
two sit behind "If your checking setting changes", and the frozen
rule is stated. An admin viewing a supplier sees that supplier's
journey.

**(dk) DONE.** Three tenant leaflets, one per journey, each true
standing alone -- a leaflet is printed and handed over, so it cannot
be conditioned at render time.

### Questions for Matt, which is why these are not built

**(dr7) is done but one reading of it was left open.** An admin now
sees one answer per question, with the agency answer winning where
both rails have one. The alternative reading -- show an admin BOTH,
labelled by rail, since they support both -- would change what an
admin reads. It is one comparison in `oneAnswerPerQuestion`'s `keep`
if Matt wants it.

**(ca) the Branches board's missing agency line: answered and
closed.** Matt ruled: keep the collapse, do not print the name twice.

### Still not built, in the order I would take them

**Rewritten 2026-10-05 after the second night run.** Nine of the ten
entries that stood here are done; what follows is what is left, and why.

1. **(dg) The whole-book sign-in load.** The decision is made (option 1,
   on demand per screen) and the change is NOT built: it moves where
   every figure on four surfaces comes from and cannot be finished and
   proven in a night. `docs/MONEY-BEFORE-DG.md` is the before-picture
   Matt asked for -- every money figure on dev with the query behind it
   -- so the after is a comparison rather than a judgement. After
   launch.
2. **(cq)/(cy) historic activity actors.** The referrer half is done
   (see below). The activity half turned out to have no reader at all:
   nothing in the product displays `activity_log.actor`, so the
   function written for it was withdrawn rather than shipped unread.
   If a surface ever shows it, the mask is 20 minutes' work.
3. **(nn)(oo) the remainder, and anything else in QUEUE.md not listed
   here.** (oo) is done for the leaflets and the browser furniture.

### Closed, 2026-10-05, rather than left quietly off the list

- **(cu) Sign-in landing.** Matt: "close it. Can't reproduce, nothing
  to fix." What was checked is in QUEUE.md: `/login` already sends a
  ready session to `/home`, a completed sign-in navigates there,
  `/home` is the per-actor resolver, and nothing in the client stores
  or restores a route. Sign-out already clears the persisted partner
  scope, origin scope and recents.
- **The agent one-pager's length.** Matt: "don't cut content. Rename
  it 'Agent guide' everywhere it's listed." Done; it is a guide and
  three pages is what a guide is.
- **(df) The supplier pickers.** Matt chose rule B on 2026-10-05: a
  negotiated agreement that has not ended. The Referred by picker is
  now type-to-search over the server's answer -- supplier-kind,
  active, holding a live agreement -- with his note, "Only suppliers
  with a live deal are shown". **"Harbour Lets" needed no label in the
  end**: it is a partner row of kind `agency` plus an agency row, the
  ordinary shape of an agency that is its own route, and it was only
  ever in that list because the old one stripped the house routes and
  nothing else. The server's answer cannot contain it.
  **ONE SUPPLIER PICKER IS DELIBERATELY LEFT ALONE**: the "Supplier
  this agency belongs to" control on the agency form. It already lists
  supplier-kind only, from Matt's 2026-10-04 instruction, and the
  live-deal filter does not belong there -- an agency is onboarded
  under a supplier before there is a deal to filter on, so applying it
  would block the first agency of every new supplier. Say the word if
  you want it anyway.
- **(cv) The Expiries dialog's default month.** Matt: "keep next month
  as the default." The rule it keeps, which is the answer (cv) asked
  for and had never been given: **the dialog opens on the earliest
  month that still has a guarantee expiring for that reader, and where
  their book has none it opens on the next calendar month**, with a
  note naming their earliest if they have one later. "Next month" is
  the fallback rather than the answer, which is what stops a new
  agency opening a month with nothing in it and pressing Download on
  an empty file. Nothing changed; the half that was unpinned -- the
  live path, which every vitest run skips because it is behind
  SUPABASE_ENABLED -- now has five assertions in
  `theExpiriesDialogOpensOnSomething.test.ts`, including that an
  expired or a refunded guarantee never decides the month.

### Done in the second night run, 2026-10-05 (branch `matt-fixes`)

Twenty commits on top of `4a39fe6`, which is the tip of the bundle
Balal already has. Each item was measured on dev before it was changed,
and each carries its own test.

| # | what | where |
| --- | --- | --- |
| 1 | No help document prices the guarantee fee. Measured: Regent is three weeks, every other agency on dev is a month, and the documents told their agents a figure GBP 307.69 too high on GBP 1,000 rent | `b713fa3` |
| 2 | The opndoor manager's blank Reporting page was ALREADY fixed on 2026-09-30; this handover said otherwise and was wrong | `c5c6fc3` |
| 3 | (cp) The Health report built to find that error could not report itself: a migration renamed its argument and left one caller behind, so it has matched no function since. It now carries the error code too | `34a4106` |
| 3b | And a sentence is not a filename: a draft month downloaded as "opndoor-statement-Reference assigned when the statement is posted.xlsx" | `966a0a8` |
| 4 | (cq) A referral opndoor sent on a customer's behalf says "opndoor (on your behalf)". The client could not work this out: users RLS hides staff rows, so the mask had to come from the database | `2cd7b37` |
| 5 | (ci) A supplier-estate agency inherits its supplier's checking setting, and the server refuses to let a click override it. Both halves were outstanding, not one | `295324f` |
| 6 | (bq)(br)(bs) The export fixes: one status rule shared with the screens, the carved share in its own column, blanks instead of structural zeros, the refund in "Activity in period", and the Export-all CSV's month, tenancy and Agency column | `a596809` |
| 7 | (ck) The duplicate check could not see the other new row: it only ever compared against CONFIRMED records, and two agencies created minutes apart are both pending. Plus the shared-email arm, and "Merge into" wired to a merge that already existed and had no caller | `d79cdb9` |
| 8 | (cl) The statement addresses go with the commission card | `9462b61` |
| 9 | (cs) A change says what it changed FROM, and an address change is recorded at all | `c402713` |
| 11a | (cg) "Fees collected" means one thing. Matt's two figures for Regent were both right: 21,447.75 gross and 15,219.29 net, and the subtraction was written four times, differently | `0027fd2` |
| 11b | (db) The go-live verification section, section 15 of this document | `79ca2e4` |
| 11d | (oo) No browser header or footer, and the three tenant leaflets print to one A4 page. Measured by printing them | `9fe451e` |
| 11e | (zz) The invite already knew the tenant's name and was not saying | `dbfb00f` |
| 11f | (cw) The sandbox proved sealed end to end, then pinned in pgTAP | `0f4f0ba` |
| 12 | The partner API on each of the three checking settings: two of the three are refused by design, and the inheritance is proved on all three | `b3e77ea` |
| 13 | Every money figure on dev, before (dg) | `f28391a` |

**Six questions were waiting for Matt. He answered all eight points on
2026-10-05 and the work is below.**

### And the eight decisions, 2026-10-05 (same branch)

| # | decision | what it came to |
| --- | --- | --- |
| 1 | (df) explain the three candidate tests, don't build | three plain lines and three lists, in QUEUE.md. "Live from" set shows 1 supplier of 10, a live negotiated agreement 3, a rate at all 8 |
| 2 | write `merge_branches` | `20261009070000`, plus the grant that made it matter: `merge_agencies` was service_role only, so the "Merge into" button added with (ck) would have failed at the click |
| 3 | mask the referrer under View as | recomputed from two facts each row keeps, swapped by SessionContext beside the commission one. A customer's rows carry no facts at all, so the name never reaches the browser that must not have it |
| 4 | close (cu) | closed, with what was checked |
| 5 | rename the agent one-pager | "Agent guide", in the shelf, the type chip, all fifteen matrix listings and its own `<title>`, which had been the management guide's |
| 6 | delete the four PDFs | 1.3 MB gone, pinned both ways |
| 7 | demo says "of the guarantee fee" | and the basis line under the figures with it |
| 8 | (cv) keep next month | recorded with the rule it keeps, and the live path pinned for the first time |

**One thing went wrong and is not fixed.** Checking whether the browser
could call `merge_agencies` at all, I ran it against two real dev
agencies rather than inside a transaction: Southbank Residential is
merged into Northgate Lettings on dev. No money moved and nothing else
was touched; the reversal is written out in QUEUE.md and needs one
approval, because writing to dev's org tables is not something I may do
unattended.

**(dr8) The landlord guide's figures are unverified.** It claims 12
months, a GBP 120,000 cap, GBP 10,000 of legal costs, notify within
two weeks of the second month of arrears, and payments beginning one
month after eviction proceedings start. **The deed's own text is not in
this repo** -- it is a PandaDoc template reached by
`PANDADOC_TEMPLATE_ID` -- so none of it could be checked against the
instrument. The claims ARE internally consistent: the same figures
appear in the landlord guide and the agent one-pager and nowhere else.
Somebody with the template must check all five.

### Smaller, all recorded with evidence in QUEUE.md

- **(ca)** The Branches board's missing agency line. Matt has ruled:
  keep the collapse, do not print the name twice. Closed.
- **(cj)/(kk)** part 3, **(cq)/(cy)** the referrer byline and historic
  activity actors, **(cp)** the draft-month reference error,
  **(ck)** the duplicate check, **(ci)** server-side refusal of a
  referencing mode on a supplier-estate agency, **(cl)** the opndoor
  manager on a supplier page, **(cm)** the back link, **(cs)** the
  audit of supplier edits, **(cu)** sign-in landing, **(cv)** the
  Expiries default month, **(cw)** the sandbox proof, **(cx)** the
  switchable deed notification, **(db)** the go-live checklist,
  **(df)** supplier pickers, **(bq)(br)(bs)** the export fixes,
  **(bx)** GR-26263's stale signed deed, **(by)** the refunded page,
  **(cg)** "Fees collected", **(nn)(oo)(pp)(zz)**.

### One thing that is NOT in the queue and should be watched

`orgLines` in `src/data/commissionSplit.ts` falls back to matching a
payee by NAME where a frozen commission line has no `org_id`. Every
line on dev today carries one, so it fires on nothing -- but if any
ever lands without an id, a renamed agency silently reports GBP 0
commission. Measured 2026-10-05: 27 lines, 0 without an id.

## 12b. The 04:45 stop on `partner-api`: the gate, and what remained then

> **SUPERSEDED IN PART, 2026-10-05.** This section is the record of the
> FIRST night run, which ended at 04:45 on `partner-api` at `4a39fe6`.
> A second run followed on the branch `matt-fixes`, and most of the
> three groups below have moved: see "Done in the second night run"
> and "Still not built" in 12a, which are current. Kept as it was,
> because the gate figures in it are the ones the bundle Balal already
> holds was cut on.

## 12b (as written at 04:45). The gate, and everything remaining in three groups

### The gate, on `db7f4f3`

| Check | Result |
|---|---|
| `npm run drift` | **clean.** 480 migrations, 403 functions, 99 policies, 52 triggers in the files; dev matches a clean apply |
| `npm run typecheck` | **clean** |
| `npm test` | **333 files, 3,648 tests, all passing** |
| pgTAP against dev, in two batches | **135 files, 0 failing assertions, 0 errored files** |

**Nothing was reverted: no assertion failed at the stop.** The first
full run did report two files red, both `Test timed out in 5000ms` and
neither an assertion: `orgList.render.test.tsx` and
`pressSendAndBeTold.render.test.tsx`, while two pgTAP batches were
running against dev on the same machine. Re-run on their own the same
second, they are **16 passed (16)**. They are the two slowest render
files in the suite and they are the ones to watch if CI ever runs the
suites concurrently.

The night's last two commits, each complete with tests: `3ea02cc`
**(cl)** and `db7f4f3` **(v)**.

### Group 1: needs Matt's decision. Not built, and not to be guessed.

1. **(dr8) The landlord guide's five claims.** 12 months, a GBP 120,000
   cap, GBP 10,000 of legal costs, notify within two weeks of the second
   month of arrears, payments one month after proceedings start. The
   deed is a PandaDoc template, not in this repo, so nobody here can
   check them against the instrument.
2. **(gg) Kestrel's hidden deal `e4b75778`** (live, scope `agency`,
   12% / 20% / 24%). The conversion plan has to be written and shown
   before anything is converted. That hold stands.
3. **The September bordereau rule.** He is confirming with the
   underwriter. Nothing was changed, as instructed.
4. **(cv) The Expiries default month.** He asked to answer first.
5. **(dr7) One answer per question, or both rails labelled for an
   admin?** Built as one answer, the agency's winning. The other
   reading is one comparison in `oneAnswerPerQuestion`.
6. **(ds) The two source PDFs in `public/help-docs/`.** Nothing points
   at them now. They go once he has read the HTML.
7. **The Regent fee wording** (item 1 of Still not built) needs his
   words, not mine: what a Regent agent should be told the fee is.

The whole-book sign-in load is **no longer here**: he chose option 1,
on demand per screen, and it stays under After launch.

### Group 2: built and tested tonight, NOT walked by me on a screen

Each has tests and a clean gate behind it. None was clicked through on
a running dev screen by me, which is the difference between this group
and the walked work above it.

1. **(cl)** The supplier Overview hides the commission card from a
   reader who may not see money, instead of reporting a refusal as
   "no commission deal set". Its statement-address half is NOT done.
2. **(v)** The branch card prints every band of a banded deal, and
   drops the total it cannot honestly add up.
3. **(dj)** Both Dev Centre tabs open on the reader's own checking
   setting, the other two behind a disclosure.
4. **(dk)** Three tenant leaflets, one per journey, each true alone on
   paper.
5. **(ds)** The Sales and conversation guide and the agent one-pager,
   rebuilt as HTML in the management-guide template.
6. **(dh)(do)(dp)** Help varies by checking setting as well as by
   level, and the matrix is generated from the code.
7. **(dt)(du)** The GBP 20 copy, and every tenant-facing refund line
   saying which fee it means.
8. **(dn)** An office named after its agency follows a rename; a typed
   name never changes.
9. **(dg)** The agency and office pickers search on the server.
10. **(cc2)(cm)(ct)** The supplier page's name, the back link, and the
    rename that no longer loses its referrals.

### Group 3: not built

In the order of "Still not built" above, which is the order I would
take them: the Regent fee wording in the Help documents; the
`opndoor_manager` blank Reporting page; **(cp)** the draft-month
reference error; **(cq)(cy)** the admin's name on a referral made for
a customer; **(ci)** the server-side refusal of a referencing mode;
**(bq)(br)(bs)** the export fixes; **(ck)** the duplicate check;
**(cl)**'s statement-address half; **(cs)** supplier edits missing
from Recent changes; **(cu)** sign-in landing; **(cw)** the sandbox
proof; **(df)** the supplier pickers; **(db)** the Go-live
verification section of this document, which is the one item on the
list that is about this document; **(q)(s)(t)** part done, with
"Included as a schedule in" still unwritten and the Source and Payee
level columns still at `exportsService.ts:969`; and
**(cx)(cg)(by)(bx)(nn)(oo)(pp)(zz)**, each with evidence in QUEUE.md.

## 13. If something goes wrong

1. **Do not restore production to fix a cosmetic fault.** The cost is every row
   written since the backup.
2. **Do restore, fast, if the app is down.** Minutes matter; the cost grows with
   every one.
3. **The clone is free.** Any question of the form "what happens if" has an
   answer you can get in ten minutes by restoring another one, and none of those
   answers is worth guessing at on production.

---

## 14. Post-cutover smoke test, before you hand back

Run this **after** the migrations, the deploys and the secrets are all in, and
**before** you tell anyone it is live. Four things, in this order, because each
one depends on the one above it. Write the answers in the boxes: if you hand back
with a box empty, nobody knows whether it works.

The whole point of this list is that **every one of these faults is silent**. A
deed that never generates, a sync that never runs and a pay link that dies
tomorrow all look exactly like a quiet Tuesday.

### 14.1 One Regent referral, all the way to a deed

| step | what you do | what proves it | box |
|---|---|---|---|
| 1 | Sign in as a Regent user and send a referral to an address you control | the referral appears at status **Sent** | ____ |
| 2 | Open the email | the fee is the **agreed fee**, not the rent, and the sentence under it names the basis ("3 weeks of rent") | ____ |
| 3 | Check the link | it is `https://<app>/pay?token=...`. **If it contains `checkout.stripe.com`, stop**: the deploy is stale and every link will die in 24 hours | ____ |
| 4 | Open the link and pay with a real card | Stripe takes the payment | ____ |
| 5 | Watch the application | it reaches **Paid**, then a deed is generated | ____ |
| 6 | Sign the deed from the tenant's email | it reaches **Deed issued** | ____ |
| 7 | Check the agent got it | the executed deed lands with the agency contact | ____ |

**If it stops at Paid with no deed**, that is the deed fault. Go to 14.4 and copy
the `stripe-webhook` and `pandadoc-webhook` logs.

### 14.2 One HubSpot sync

The sync is **per partner and cursor-based**: each partner has a row in
`hubspot_sync_cursor_partner` recording how far it has got, and a partner that
fails is marked stuck rather than retried for ever.

```sql
-- 1. IS ANY PARTNER STUCK? This is the whole diagnosis in one query.
--    stuck_error is the message that stopped it. On a healthy system every
--    stuck_since is null, which is what dev shows today.
select partner_id, last_at, stuck_since, left(stuck_error, 200) as stuck_error
  from public.hubspot_sync_cursor_partner
 order by stuck_since nulls last, updated_at desc;
```

**This will be the first proven sync anywhere.** `hubspot_sync_events` is empty on
dev and always has been, because dev has no HubSpot token: the sync has nothing
to authenticate with and has therefore never applied an event. So there is no
"it worked on dev" to compare against, and your run on the clone is the first
real evidence the chain works end to end. Treat an empty table before your run as
expected, and a row after it as the thing you were sent to establish.

Wait two minutes (the cron runs `*/2 * * * *`) or invoke `hubspot-sync` by
hand with the ops secret, and:

```sql
-- 2. A row per event applied, newest first. THIS IS THE PROOF.
select id, target, application_id, applied_at
  from public.hubspot_sync_events
 order by applied_at desc limit 5;
```

**Do not try `select count(*) from public.hubspot_pending_events()`.** It takes
five arguments (`p_partner, p_last_at, p_last_id, p_kinds, p_limit`) and is
driven by the cursor, so it is not a queue you can peek at without supplying a
partner and its position. Read `hubspot_sync_cursor_partner` instead.

**The failure modes, in the order they are worth checking:**

| what you see | what it means |
|---|---|
| `stuck_since` set on one partner, others fine | that partner hit an error and was parked. `stuck_error` names it. The others keep syncing, which is the design |
| no rows in `hubspot_sync_events` and nothing stuck | the function is not being reached. Almost always a 401: see 14.4 |
| a 403 in the function logs | the token. `HUBSPOT_ACCESS_TOKEN` is absent, expired, or lacks a scope |
| the same error every two minutes for ever | one poisoned event. Check `stuck_error` and the newest applied event to see where it halted |

#### The production alert you will be replaying

Production has been raising this **daily since at least 25 September**:

```
hubspot-sync referral_created GR-20675: no partner map for partner_id
1f305284-a6d8-4eb0-9b06-b5fe50648b7b
```

Two migrations deal with it and they do different halves, which is why both are
needed:

| migration | what it does |
|---|---|
| `20261005250000` | backfills `hubspot_partner_map` and adds the trigger, so every partner has a mapping and every NEW event associates correctly |
| `20261006130000` | winds that partner's cursor back, so the events already drained **without** an association are read again |

**Why the backfill alone is not enough.** A missing map row goes through
`configGap()` in hubspot-sync, which warns and raises an incident and does NOT
throw. So the event is not an error: the applicant properties are written, the
event completes, and the cursor moves past it, while the association step
deliberately leaves its ledger key unwritten because it did not happen. The
application ends up with an applicant in HubSpot attached to no partner company,
and a cursor that has already gone past the only events that would retry it.
`ensureAssoc` runs once per EVENT, so an application whose events are all drained
is never revisited.

**Why the replay is safe.** Every step that already succeeded wrote its ledger
key to `hubspot_sync_events`, so the replay reads "applied" and skips it. The one
step with no key is the one that failed. A replay therefore does exactly the
missing work and nothing else.

**What to expect on the clone.** `20261006130000` prints a notice naming how many
partners it rewound. On a database with nothing missing it rewinds none, which is
what it does on dev for seven of the eight partners; dev's eighth is
`opndoor-agents`, rewound from 17 September to 14 September. On production expect
at least `1f305284-...` to move.

```sql
-- BEFORE the migrations, note this partner's position:
select partner_id, last_at from public.hubspot_sync_cursor_partner
 where partner_id = '1f305284-a6d8-4eb0-9b06-b5fe50648b7b';

-- AFTER the migrations, last_at should be EARLIER than it was.
-- Then let the cron run and check the association keys appear:
select id, target, application_id, applied_at
  from public.hubspot_sync_events
 where id like 'assoc:%:partner'
 order by applied_at desc limit 10;
```

**The outcome you are looking for:** rows appearing with ids of the form
`assoc:<application>:partner`, and the daily "no partner map" alert stopping. If
the alert persists after a full cron cycle, the map row for that partner is still
missing, which means `20261005250000` did not run: check it is applied before
looking anywhere else.

### 14.3 A pay link opened the next day

Send a referral, then **open its pay link tomorrow**. It must still work.

This is the one fault you cannot test in the same sitting, and it is the one that
has recurred. The token lives 90 days and is refreshed on every reminder and
resend (asserted in `supabase/tests/pay_link_outlives_a_day.test.sql`). What dies
in 24 hours is a Stripe Checkout session, which is what the old deployment
emailed. So if step 3 above showed a `/pay?token=` link, this will pass; check it
anyway, because it is the only way to be sure the deployed code is the code in
this repo.

### 14.4 Reading `cron_health` and the function logs

`cron_health()` is an admin RPC, not a table. Run it signed in as an opndoor
admin at AAL2 (it refuses otherwise), from the SQL editor or the Health screen:

```sql
select jsonb_pretty(public.cron_health());
```

**Read it in this order, and mind the trap it was written for:**

1. **`counts`** is the summary. On a healthy production morning:
   `{"anomalies":0,"http_errors":0,"deed_failures":0,"email_failures":0,"webhook_failures":0}`.
   Any non-zero is where to look first.
2. **`recent_http`** is the authoritative signal. Each entry has a real
   `status_code` and the response `content`, e.g.
   `{"status_code":200,"content":"{\"ok\":true,\"claimed\":0,...}"}`.
3. **`jobs[].last_status` is NOT the authoritative signal, and this is the trap.**
   The crons run `select net.http_post(...)`, so `cron.job_run_details` reports
   `succeeded` the moment the request is **queued**. A cron whose function
   answers **401** shows `last_status: "succeeded"` for ever. That is the
   silent-401 class, incident #1, and it is exactly how "the HubSpot sync is
   broken" looks from the database: a green cron and no data.
   Trust `recent_http.status_code`, and if `http_status_code` on a job is `null`
   it means the correlation could not be made, **not** that it succeeded.

A 401 from a cron means the function's `verify_jwt` gate is on when it should be
off. Check section 6a: the reconciliation must print `mismatches: 0`.

**Function logs**: Dashboard → Edge Functions → the function → Logs, or
`npx supabase functions logs <name> --project-ref <REF>`.

### 14.4a The Dev Centre on live: the sandbox banner must be gone

Matt, 2026-10-03: *"on live, confirm the Dev Centre banner 'This project
reaches nothing real. No card is charged…' does not appear (it's dev-only), and
that live keys are clearly marked as creating real applications."*

**Why this is in the smoke test and not just a nice-to-have.** That sentence is
true of dev and is a lie on production. A supplier's developer reading it on
the live Dev Centre would conclude that nothing they do can charge a card or
email a tenant, and the first thing they would do is test with a live key
against a real address. The banner is the one piece of copy on the site whose
being wrong actively invites the mistake it describes.

**It is gated on the project, not on the key.** `DevCentre.tsx` draws the note
only when `env.id !== 'production'`, and `env` is resolved from the Supabase
project the app is pointed at. So on live it should be absent by construction;
this step is confirming the gate works where it matters, because a gate nobody
has watched fire is a gate nobody knows about.

| step | what you do | what proves it | box |
|---|---|---|---|
| 1 | Sign in to **live** as an opndoor admin and open the Dev Centre | the page loads | ____ |
| 2 | Read the banner at the top | it says a key's prefix decides the mode: `opnd_test_` creates sandbox applications, `opnd_live_` creates real ones | ____ |
| 3 | Look for the second paragraph | **"This project reaches nothing real"** is **NOT** there. If it is, the app is pointed at a non-production project, or the env resolver is wrong: **stop and tell us** | ____ |
| 4 | Look at the environment chip beside it | it reads **Production**, not Sandbox or Development | ____ |
| 5 | Mint a key and read its row | a live key is labelled as creating **real** applications, and the prefix on it is `opnd_live_` | ____ |

**If step 3 fails, nothing else in this section matters.** A live Dev Centre
that claims to reach nothing real is worse than one with no banner at all.

### 14.5 If something still fails, copy these to us

We cannot see production. For each fault, copy **the whole log line including the
timestamp**, not a summary, and redact nothing structural (we redact tokens
ourselves; `payment_url` and anything matching `token`, `secret` or `key` is
already redacted by `_shared/redact.ts` before it is logged).

| fault | copy from | what we need to see |
|---|---|---|
| **Deed not generating** | `stripe-webhook` logs around the payment | whether `checkout.session.completed` arrived at all, and its HTTP response. If it is absent, the Stripe endpoint is not registered for this mode |
| | `pandadoc-webhook` logs | any `Invalid signature`, and whether `document.completed` arrived |
| | the Stripe dashboard, that endpoint's delivery list | the response code Stripe recorded. Stripe retries a 5xx and gives up on a 4xx |
| | the PandaDoc dashboard, the document | whether it was created at all, and which recipient email it went to |
| | SQL | `select guarantee_ref, status, deed_state, pandadoc_document_id, paid_at from public.applications where guarantee_ref = '...'` |
| **HubSpot sync** | `hubspot-sync` logs, the most recent 20 lines | the status code and body. A 401 is the gate; a 403 from HubSpot is the token; a repeated identical error every two minutes is one poisoned event blocking the queue |
| | SQL | the `hubspot_sync_cursor_partner` row for that partner, especially `stuck_since` and `stuck_error`, and the newest 5 rows of `hubspot_sync_events` |
| | `cron_health()` | the `hubspot-sync` entry, and `recent_http` around its schedule |
| **Pay link dead** | the email itself | the full href. `checkout.stripe.com` means a stale deploy; `/pay?token=` means look further |
| | `payment-page` logs for that token | `410` is genuinely expired, `404` is an unknown token, `400` is a malformed one |
| | SQL | `select guarantee_ref, expires_at, first_viewed_at from public.payment_page_tokens where guarantee_ref = '...'` |

For any of them, `select jsonb_pretty(public.cron_health())` and the output of
the section 6a reconciliation are worth sending unprompted. Between them they
answer "is it deployed, is it gated, and did it run" without another round trip.

---

## 15. Go-live verification: Matt's own pass, after the cutover

> **(db)** Matt, 2026-10-04: "Add a 'Go-live verification' section to
> HANDOVER-BALAL.md: a checklist Matt can do himself on live after cutover,
> with what he should see at each step (Health all green; Stripe live webhook
> deliveries succeeding; Resend domain verified; emails with no review-copy
> banner; Rightmove's deal, checking setting and agencies inheriting; one real
> single referral through a Rightmove agency going straight to payment, paid,
> signed, deed delivered, then refunded in Stripe and cancelled; sign-in as
> admin, Rightmove Management and Referrer). Balal ticks each with a screenshot
> before Matt signs off."

**THIS IS NOT SECTION 14.** That one is Balal's, run immediately after the
cutover, and it ends with him handing back. This is Matt's, run after that, and
it is the sign-off. Every row says what he should SEE, because a checklist whose
rows are "check X works" is a list of opinions.

**Balal: tick each row with a screenshot before you hand it over.** A tick with
no screenshot is the thing this section exists to stop.

### 15.1 The machinery is running

| # | Do this | What you should see | If not |
|---|---|---|---|
| 1 | Health, as opndoor admin | Every cron row green, each with a `last_ok` inside its own window. `portal_errors` 0 in the last 24 hours | A red row names its own function. Section 14.4 reads the logs |
| 2 | Health → the statement line | "Statements can be posted" true, and the invoice email set to the real address | `set_app_setting_text` on the Health field, section 14.4a |
| 3 | Stripe dashboard → Developers → Webhooks → the LIVE endpoint | Recent deliveries all 200, none pending, none failed. At least one `checkout.session.completed` | A 4xx means the endpoint is pointed at the wrong project; a 5xx is ours and the log line is in `stripe-webhook` |
| 4 | Stripe dashboard, top left | It says **Live mode**, not Test. The key the portal uses is `sk_live_` | `livemodeCredentials.ts` refuses a mismatch at the boundary, so a wrong key fails loudly rather than quietly |
| 5 | Resend dashboard → Domains | `opndoor.co` **verified**, and the DKIM and SPF rows green | An unverified domain still sends, into spam. This is the row most likely to be amber on day one |
| 6 | Dev Centre, as admin | **No sandbox banner.** The banner means the portal believes it is on test credentials | Section 14.4a |
| 6a | The `payment_url` in an API response, or the link in a fee email | the real domain. **Measured on dev 2026-10-05**: a referral created through the partner API came back with `http://localhost:5174/pay?token=...`, which is right for dev and is a dead link anywhere else | this is a different setting from Site URL and APP_URL in section 7; all three point at a domain and all three must be the live one |

### 15.2 The emails are the real ones

| # | Do this | What you should see | If not |
|---|---|---|---|
| 7 | Send yourself one of each: the fee-paid email, the signed-deed email | **No review-copy banner.** No "this is a copy for review" strip at the top, and the From address is the real one, not `onboarding@resend.dev` | The banner is driven by the review-inbox setting. It must be off on live, and it is the single most visible sign of a half-cut-over environment |
| 8 | Read the deed email as a tenant would | The guarantee reference, the property, and one link that opens the deed. No internal reference, no partner slug | |
| 9 | Check who the signed deed went TO | The agency's office email, or the agency email where the office has none. **Never** a referrer's personal address unless that is the nominated recipient | `org_deed_readiness` names the recipient per office. A missing one is why a deed sits undelivered |

### 15.3 Rightmove is set up as agreed

| # | Do this | What you should see | If not |
|---|---|---|---|
| 10 | Suppliers → Rightmove → Commission | Their deal, with the agreed rate and basis, and **"Live from"** a real date rather than "Not live yet" | No deal means every referral prices at 0%: the Overview says so in as many words |
| 11 | Suppliers → Rightmove → Settings | The checking setting, in the plain wording: "They check tenants, and opndoor accepts them as sent" for straight-to-payment | |
| 12 | Suppliers → Rightmove → Agencies → open one | **No "How are ...'s tenants checked?" choice.** It reads "Checked as Rightmove sets it: ..." with a link to Rightmove's settings | That is the inheritance (ci). The server refuses a mode set on a supplier-estate agency, so a stray value cannot be there |
| 13 | The same agency's Commission tab | "On Rightmove's agency deal: ..." and who pays it, never "Opndoor standard" | |
| 14 | Count their agencies | The number you expect. **Ask what it is before go-live**: see (dg) in section 12a. At a few hundred nothing bites; at thousands the sign-in load is the first thing to feel it | |

### 15.4 One real referral, all the way, and then back out

Use a **single tenant**, a real card, and a property you do not mind seeing in
the book. Through a **Rightmove agency**, so the rail under test is the one
Wednesday is for.

| # | Do this | What you should see | If not |
|---|---|---|---|
| 15 | Refer, as a Rightmove Referrer | The fee previewed on the form before you send it, from Rightmove's own deal | A fee that looks like one month's rent on a weeks-based deal means the agreement is not resolving |
| 16 | The tenant's email | A payment link, and **no eligibility step**: straight to payment is the setting | A decision step means the checking setting is not what 15.3 said |
| 17 | Pay it | The application moves to **Paid** within seconds, and the deed is created | Stripe's delivery list (row 3) is where this is answered |
| 18 | Sign as the tenant | **Deed Issued**, the reference assigned, the expiry a year out | |
| 19 | The agency's inbox | The signed deed, to the address row 9 named | |
| 20 | Applications, admin | One row, status **Deed Issued**, the agency and office right, the referrer named | |
| 21 | Reporting, admin, this month | Fees collected includes this fee, net of refunds, and commission at Rightmove's rate | "Fees collected" is net everywhere since (cg) |
| 22 | **Refund it in Stripe**, in full | Within a minute: status **Refunded**, the guarantee cancelled, "Cancelled: fee refunded" on the deed, and the fee out of Reporting again | If the status stays Paid, the refund webhook did not arrive: Stripe's delivery list, `charge.refunded` |
| 23 | The bordereau for this month | The row gone, or not there at all. A cancelled guarantee is not on risk | |

### 15.5 The three sign-ins

| # | Do this | What you should see | If not |
|---|---|---|---|
| 24 | Sign in as **opndoor admin** | Home, queues first. Reconciliation, Finance, the bordereau and Health all reachable | |
| 25 | Sign in as **Rightmove Management** | Reporting, with their own figures and "Owed to you" as the headline. Their agencies, their people. **No** Reconciliation, **no** other supplier, **no** opndoor team | |
| 26 | Sign in as **Rightmove Referrer** | Their own referrals only. **No commission anywhere**, no League money, no statements | A commission figure here is the one failure on this page worth stopping for |
| 27 | On each, open Help | Guides for that level, and the fee described without a figure: "the fee agreed with your agency" | Since (1) tonight, no document states a basis. A document saying "one month's rent" is a stale deploy |

### 15.6 Sign-off

Matt signs off when every row above has a tick and a screenshot, and when
**rows 22 and 26 in particular** have been seen with his own eyes: one is the
money going back out cleanly, the other is a customer not seeing somebody
else's.

Anything that fails goes to us with the evidence section 14.5 asks for, not as
a description.

---

## 16. Bringing live up to `matt-fixes`, after Matt's walk of 2026-10-09

Live is on `partner-api` plus about twelve migrations of Balal's own. This
section is the whole of what moves, in order, and the one thing that needs an
answer before any of it starts.

### 16.0 THE QUESTION THAT COMES FIRST, and nothing else should start until it
### is answered

Balal's repo has **492 migration files**, latest
`20261008290100_picker_search_all_authorised_routes.sql`. `partner-api` has
480 and this branch has 490, so he holds about twelve migrations that are in
neither of ours.

`20261008290100` sorts between our `20261008290000` and our `20261009000000`,
so on filename order his extras land BEFORE everything on this branch. That
is lucky rather than safe: **wherever one of his twelve redefines a function
that one of our twelve also redefines, ours sorts later and wins, and his
change is discarded in silence.** The twelve on this branch redefine these,
and these are the names to check his twelve against:

| our migration | functions it redefines |
| --- | --- |
| `20261009000000` | `report_portal_incident` |
| `20261009010000` | `opndoor_user_ids` (new) |
| `20261009030000` | `set_agency_referencing_mode` |
| `20261009040000` | `org_shares_contact_email` (new), `reconciliation_queue` |
| `20261009050000` | `set_agency_details`, `set_branch_details` |
| `20261009060000` | `tenant_invite_summary` |
| `20261009070000` | `merge_branches` (new), grant on `merge_agencies` |
| `20261009080000` | `suppliers_that_can_take_referrals` (new) |
| `20261009090000` | `agreement_for_agency`, `create_agreement`, `admin_add_agency`, `resolve_pricing_agreement_for_agency` (new) |
| `20261009100000` | `list_managed_users`, `mint_staff_invite` (new), `claim_staff_invite` (new) |
| `20261009120000` | `place_the_missing_single_offices` (new), `admin_add_agency` (again) |
| `20261009130000` | `place_the_missing_single_offices`, `admin_add_agency` (again) |

**Balal: run this on live and send the output.** It is read-only and it is the
only thing needed to answer it.

```sql
select version, name
from supabase_migrations.schema_migrations
where version > '20261008290000'
order by version;
```

Any of his twelve that touches a name in the table above has to be re-applied
as a NEW migration after ours, with a timestamp later than `20261009130000`.
That is this repo's standing rule and it is the same rule either way round: a
correction to an earlier migration goes in a new file, never by editing or
re-running one.

### 16.1 Migrations

Twelve files, already written and already proven against dev:

```
20261009000000_the_unreadable_incident_names_the_error.sql
20261009010000_which_of_these_referrers_are_opndoor.sql
20261009030000_a_supplier_estate_agency_cannot_set_its_own_mode.sql
20261009040000_the_duplicate_check_sees_the_other_pending_row.sql
20261009050000_a_change_says_what_it_changed_from.sql
20261009060000_the_invite_knows_who_it_was_sent_to.sql
20261009070000_two_offices_can_be_merged.sql
20261009080000_the_suppliers_that_can_take_a_referral.sql
20261009090000_an_agency_with_no_office_still_has_a_deal.sql
20261009100000_a_staff_invite_lasts_seven_days.sql
20261009120000_the_office_backfill_knows_our_own_estate.sql
20261009130000_the_supplier_test_is_a_supplier_test.sql
```

`supabase db push --project-ref <LIVE_REF>` applies only the ones live's
ledger does not already hold, which is the right behaviour here: live's ledger
is real (492 rows), unlike dev's.

`20261009100000` creates a table, `public.staff_invites`. It is additive and
nothing reads it except the two functions in the same file and
`list_managed_users`.

**`20261009120000` and `20261009130000` are the only ones that write ROWS**,
and they are the only ones that need anything looked at before and after.
Everything else in the set replaces functions. They are a pair: the second
corrects one filter in the first and re-runs the same bounded backfill, which
is free because it is idempotent.

#### 16.1a Before you apply it: count what it will create

It gives every **confirmed** agency on Opndoor's **own** estate that has no
office exactly one, named after the agency. Run this first, read-only, and keep
the output:

```sql
select a.id, a.name, p.slug as partner, p.partner_kind, a.livemode, a.review_state
from public.agencies a
join public.partners p on p.id = a.partner_id
where p.partner_kind <> 'supplier'
  and not a.is_placeholder
  and a.review_state = 'confirmed'
  and not exists (select 1 from public.branches b where b.agency_id = a.id)
order by a.name;
```

Expected: **Regent Letting & Property Management, and nothing else.**

**The migration will REFUSE if that query returns more than one row**, and it
will name them in the error. That is deliberate, not a bug. A branchless
agency is not always a fault: `20260927100000_agency_without_branch.sql` stood
up the skeleton-group case on purpose, where Opndoor creates a group and its
agencies and each manager adds their own offices on first login, and it
rejected "invent branch names on the operator's behalf" by name. The two
shapes cannot be told apart in the data, so if there are several, a person has
to look at the list before offices are invented under them.

**The bound of 1 is Matt's ruling, not a default**, 2026-10-09: "on live it
should only ever be Regent, and anything more should stop the deploy." So do
not raise it to make the deploy pass. A refusal is the designed behaviour.

If it refuses: send Matt the list from this query. Once he has agreed the
names, run the function yourself with the real count and then carry on:

```sql
select public.place_the_missing_single_offices(<the number of rows above>);
```

The three shapes the function excludes by construction, so this query excludes
them too and what you see is what it will do: a supplier's agencies, the house
"Unattached" placeholders, and any agency still awaiting review. The
`referencing-partner` hand-over rail is NOT excluded, deliberately:
`20261009030000` ruled that the filter is supplier-ness exactly, because that
rail is Opndoor's own plumbing rather than a third party's book. On dev its
only agency is an "Unattached" placeholder that already has an office, so
nothing is expected from it.

If Matt has already added Regent's office by hand on the screen, the list
comes back empty and the migration correctly does nothing: the insert is
guarded on there being no office, not on the migration not having run.

#### 16.1b After you apply it: confirm what it created

```sql
select oa.at, oa.detail, b.name as office, a.name as agency, b.livemode, b.review_state
from public.org_audit oa
join public.branches b on b.id = oa.entity_id
join public.agencies a on a.id = b.agency_id
where oa.detail like '%created for an agency that had no office%'
order by oa.at;
```

A good result is one row per name from 16.1a, each office carrying the
agency's own name and the agency's own `livemode` and `review_state`, and
`actor` reading `opndoor` rather than a person. No rows, when 16.1a listed
some, means the function did not run and the `do` block at the bottom of the
file was skipped.

### 16.2 Edge functions

**One new:** `accept-invite`. **One changed:** `invite-user`.

```
supabase functions deploy accept-invite invite-user --project-ref <LIVE_REF>
```

`accept-invite` MUST be deployed with **`verify_jwt = false`**. The invitee has
no session: that is the entire situation the function exists for. It is
recorded in `supabase/config.toml`, so a deploy run from the repo root with no
flags gets it right; a deploy run from somewhere else needs
`--no-verify-jwt`. With verification on, every invitee is rejected with a 401
before a line of it runs and nobody can accept an invitation at all.

**Migrations before functions.** `invite-user` calls `mint_staff_invite`, which
`20261009100000` creates. Deployed first, every invite fails.

### 16.3 Website build

The React bundle has to be rebuilt and redeployed, and it is the leg nobody
checked on the 7th. `npm ci && npm run build`, then publish `dist/`.

These need the new bundle to work at all:

- `/accept-invite` reading `?token=` (D). Without it, the seven-day link in
  every invitation email loads a page that ignores the token and then tells
  the invitee the link is not valid.
- The Agreement card and Commission tab reading a branchless agency's deal
  (C) work from the server, so those are fixed by the migration alone. The
  Team list's invitation dates and states are client-side and need the build.

**Tell us the deployed commit sha.** A stale bundle against a current database
is the exact shape of "it worked on dev", and it is invisible from both the
Supabase dashboard and SQL.

### 16.4 The five missing cron jobs

Matt found 14 of 19 on live. Missing, with what each one stops:

| job | schedule | what is not happening on live right now |
| --- | --- | --- |
| `partner-webhooks` | `* * * * *` | **Partners are never notified of anything.** Deliveries queue in `partner_webhook_deliveries` forever, silently |
| `renewal-notices-0700` | `0 7 * * *` | Guarantees end with no renewal outreach |
| `renewal-notices-0800` | `0 8 * * *` | the BST half of the same job |
| `referencing-callback` | `*/10 * * * *` | Executed deeds never reach Lettings. Rail 4 only, so it can wait if rail 4 is not live |
| `hubspot-map-check` | daily | Field-map drift is never noticed. Silent by design |

Exact statements are in `supabase/PAYMENT-REMINDERS.md`, `PARTNER-API.md` and
`TENANT-PLATFORM-SETUP.md`. `partner-webhooks` is the one to do first: it is
every minute, it is silent, and the queue it drains is already filling.

After creating them, check with

```sql
select j.jobname, max(d.start_time) filter (where d.status = 'succeeded') as last_ok
from cron.job j left join cron.job_run_details d on d.jobid = j.jobid
group by j.jobname order by j.jobname;
```

A job that exists and has never run is as broken as one that does not exist.

### 16.5 Getting Balal's twelve migrations and his `pandadoc-webhook` back into
### this repo

Two different problems with two different answers.

**The twelve migrations.** They cannot be reconstructed from live, because a
database is the result of a migration and not the migration. He has the files.
He sends the twelve `.sql` files; they go into `supabase/migrations/` under
their own existing names, which already sort between `20261008290000` and
`20261009000000`, so nothing is renamed and nothing moves. Then
`npm run drift` is run against a database they have been applied to. Anything
that clashes with 16.0's table is re-issued as a new migration after
`20261009100000` rather than edited.

**The `pandadoc-webhook` redeploy.** A function body CAN be read back, so this
one is answerable without asking him to remember what he changed:

```
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  https://api.supabase.com/v1/projects/<LIVE_REF>/functions/pandadoc-webhook/body \
  -o live-pandadoc-webhook.bundle
```

That returns the deployed bundle. Diff its `index.ts` against the repo's. If
they differ, the live one is the authority for whatever he fixed, and it comes
back as an ordinary commit to `supabase/functions/pandadoc-webhook/index.ts`.
If they do not differ, the redeploy was a redeploy and there is nothing to
recover.

### 16.6 The order, in one list

1. Answer 16.0. Do not start until the list of his twelve is in hand.
2. Run 16.1a, read the list, then apply the twelve migrations (16.1), then
   run 16.1b.
3. Deploy `accept-invite` and `invite-user`, verification off on the first (16.2).
4. Rebuild and redeploy the website, and report the commit sha (16.3).
5. Create the five cron jobs, `partner-webhooks` first (16.4).
6. Send the twelve migration files and the `pandadoc-webhook` bundle (16.5).
7. Run `npm run drift` against live's schema and confirm it is clean.

---

## 17. The scanner fix, 2026-10-13. Deploy the website FIRST

Fourteen Regent invites died inside twelve minutes on the morning of 13
October. Regent's mail scanner opened each link, and a GoTrue action link
verifies its one-time token on a plain GET, so every token was spent before
its owner clicked. Matt's evidence: 13 of the 14 had `last_sign_in_at` set by
07:57 while `public.users.status` was still `pending`. A scanner cannot set
`last_sign_in_at`; GoTrue does, when the verify endpoint is hit.

Every emailed auth link now points at `/auth/confirm` on the portal and
carries a `token_hash`, which is the same credential with no endpoint attached.
That page does nothing until somebody presses a button.

### 17.0 THE ORDER IS NOT THE USUAL ORDER. The website goes first

**Deploy the React bundle BEFORE the edge functions.** The new links point at
`/auth/confirm`, a route that does not exist in the bundle currently on live.
If the functions go out first, every invite and reset email sent in between
lands on a 404 and is unusable.

The reverse is safe: a new bundle with the old functions simply never receives
a `/auth/confirm` link, and the two older routes it still serves
(`/accept-invite`, `/reset-password`) keep working exactly as now.

1. `npm ci && npm run build`, publish `dist/`, and confirm the deployed commit.
2. Then the migration (17.2), then the three functions (17.3).

### 17.1 Nothing to change in the Supabase dashboard

Worth stating plainly, because it is the question Matt asked and the answer is
unusually short.

| thing | change needed |
| --- | --- |
| **Email templates** | **None.** GoTrue's own mailer is not used at all. Every message is built from our templates and sent through Resend; `generateLink` is called only for the token |
| **Redirect URL allow-list** | **None, and it matters less than it did.** No sender passes `redirectTo` any more, so the allow-list no longer gates a single staff auth link. Leave the existing `<APP_URL>/**` entry in place for anything else that may want it; do not remove entries |
| **Email OTP expiration** (`mailer_otp_exp`) | **None.** CUTOVER 1.1's 1800 seconds is still the right value, and is now genuinely consistent with the copy: a reset link is meant to be short lived, and an invitation's seven days come from our own token, with the GoTrue token minted at the moment of the click |
| **Edge function secrets** | **None new.** `APP_URL` must be the production portal origin, which it already must be, and is now load-bearing for the link itself rather than only for a redirect. Worth re-reading it before you start |

**One live fragility is removed rather than added.** `send-password-reset` and
`invite-user` each carried a degraded path for the case where the allow-list
refused a `redirectTo` with a query string on it, because when that happens
`generateLink` errors and the sender reads the error as "no such account" and
sends **nothing at all, silently**. Neither passes `redirectTo` now, so neither
can fail that way.

### 17.2 One migration

```
20261013000000_an_invitation_is_spent_only_once_it_works.sql
```

It adds `peek_staff_invite`, a read-only twin of `claim_staff_invite`. The
defect it fixes was found by probing the deployed function rather than by
reading it: the claim spent the token BEFORE the sign-in link was minted, so a
failure in between left an invitation marked used and a person who got
nothing. `accept-invite` now peeks, mints, then claims.

This migration is additive and writes no rows. It must land **before** the new
`accept-invite`, which calls the new function.

### 17.3 Three edge functions

```
supabase functions deploy accept-invite invite-user send-password-reset --project-ref <LIVE_REF>
```

Run it from the repo root so `supabase/config.toml` sets the flags.
`accept-invite` must go out with **`verify_jwt = false`** (the invitee has no
session); config.toml records that, and a deploy from elsewhere needs
`--no-verify-jwt`.

**`tenant-auth` is in the list too, as of the tenant fix later the same day.**
It had used `hashed_token` since it was written, but in the URL FRAGMENT and
exchanged on page load, which a plain fetch cannot touch and a scanner that
RENDERS the page can. Both its reset senders now emit
`/apply/reset?token_hash=...&type=recovery`, and that page waits for a button.

So the deploy line is:

```
supabase functions deploy accept-invite invite-user send-password-reset tenant-auth --project-ref <LIVE_REF>
```

Measured with real headless Chrome against dev, both ways: the old page's
render spent the token, the new page's render left it live.

**One thing the tenant fix does NOT change, and it is worth knowing.** A
rendering scanner that opens a tenant's `/pay?token=` link still trips
`first_viewed_at` and writes a `tenant_viewed_payment_page` activity row, so an
agent can be shown "the tenant viewed the payment page" when only a scanner
did. That token is a durable door rather than a one-time credential, so
nothing is spent and the link keeps working; what is wrong is a signal, not an
account. Left as it is, and recorded here rather than fixed, because telling a
scanner from a tenant is not something the page can do.

### 17.4 Then re-invite everyone still waiting

Every link sent before the deploy is a spent GoTrue verify URL. None of them
can be rescued, so everyone still pending needs a fresh invitation **after**
17.1 to 17.3 are all done. Read the list first:

```sql
select u.full_name,
       u.email,
       p.slug                                   as partner,
       u.role,
       u.sees_commission,
       au.last_sign_in_at,
       au.last_sign_in_at is not null           as scanner_or_person_opened_it,
       si.sent_at::date                         as invite_sent,
       si.expires_at::date                       as invite_expires,
       case when si.user_id is null              then 'none'
            when si.cancelled_at is not null     then 'cancelled'
            when si.claimed_at is not null        then 'used'
            when si.expires_at <= now()           then 'expired'
            else 'live' end                      as invite_state
from public.users u
join auth.users au on au.id = u.id
left join public.partners p on p.id = u.partner_id
left join public.staff_invites si on si.user_id = u.id
where u.status = 'pending'
order by p.slug, u.full_name;
```

Expected on live: the Regent people and Ethan Li at Brithive. `invite_state`
reads `none` for anybody invited before `20261009100000` reaches live, which is
all of them today.

**`scanner_or_person_opened_it` is the column to read.** True on a `pending`
row is the fault's own signature: a session was minted and nobody finished.
That is the 13 of 14 Matt measured.

Then resend from the portal, Team, the row menu, **Resend invite**, one per
person. Each resend mints a fresh seven-day token and retires the previous
link, and the confirmation now says so. Do not resend before the website is
deployed: the link would point at a route that is not there yet.

### 17.5 How to tell it worked, in one check

Pick one invitee and, before telling them, fetch their link the way a scanner
does:

```
curl -s -o /dev/null -w "%{http_code}\n" "https://<portal>/auth/confirm?token=<theirs>&type=invite&tab=agent"
```

Then:

```sql
select claimed_at, expires_at from public.staff_invites
 where user_id = (select id from public.users where lower(email) = '<theirs>');
```

`200` from the curl and `claimed_at` still **null** is the whole fix. On dev,
end to end: the scanner's GET left the token unspent, the button's POST
returned a 56-character `token_hash` with no verify URL in the reply,
`verifyOtp` with that hash signed in, the same hash a second time was refused,
and the invitation was recorded as used.

---

## 18. Two signed deeds live never recorded, and recovered, 2026-10-15

GR-20611 and GR-20612 were signed in PandaDoc on 14 October. Live recorded
neither, for twenty-four hours, while both tenants had paid (£600 and
£1,488.46) and Regent was re-sending a signing link to a tenant who had already
signed.

**Both are now recovered.** Migration `20261015000000` and `deed-sweep` version
10 are on live, and the sweep reconciled both deeds at 13:04 UTC on 15 October:
executed, signed PDFs stored (735,142 and 733,039 bytes), delivered to the
agency, tenants emailed. `deeds_awaiting_completion` is at zero.

> **THIS SECTION WAS WRONG WHEN FIRST WRITTEN, and the correction is the useful
> part.** It said the callbacks "were lost in flight" during the deploy of the
> evening of 14 October, and prescribed deploying `pandadoc-webhook` alongside
> `deed-sweep`. Reading live disproved the first and made the second dangerous.
> Both are corrected below. If you remember the earlier version, discard it.

### 18.0 What actually happened

**The callbacks arrived.** Both documents already held a
`<document>:document.completed` row in `pandadoc_events`, and `ops_alerts`
carried this, in the hour GR-20611's completion landed:

```
pandadoc-webhook: Cannot read properties of null (reading 'ok')
```

`downloadPdf` returned **null**, and the next line in the completion sequence
reads `pdf.ok`:

```ts
const pdf = await downloadPdf(docId, eventLivemode);
if (!pdf.ok || !pdf.bytes) {              // <- TypeError on null
  ...
  await service.from("pandadoc_events").delete().eq("id", evId);   // never reached
```

The delete that releases the dedup row sits **inside** the branch the throw
stopped us reaching. So the row stayed behind as a tombstone: a committed claim
with no work behind it. PandaDoc retried, hit the primary key, and the handler
answered 200. Gone for good, with one alert.

The evidence chain, all read off live:

| fact | what it rules out |
| --- | --- |
| `:document.viewed` carries an `application_id` | the application lookup works for that document |
| `:document.completed` carries `application_id = null` | the handler never reached the write that follows execution |
| `deed_state` still `awaiting_tenant`, `executed_pdf_path` null | `apply_deed_executed` never succeeded |
| the only `.ok` read between those two points is `pdf.ok` | leaves one line it can be |

**It is a race, not an artefact of a deploy.** PandaDoc fires
`document.completed` before it renders the signed PDF, which this codebase
already knew and says in a comment. GR-20611 was sent at 13:05:41 and completed
at 13:14:48; GR-20612 sent 17:06:12, completed 17:09:05. Any tenant who signs
that fast can hit it. GR-20612 has no `webhook_error` at 17:00, so it failed by
a second route with the same end state.

**Our own `downloadPdf` cannot return null.** Live's can, which is how we know
live's `pandadoc-webhook` is not ours: `origin/main` carries the commit
*"Pandadoc logic same for testing delay if not yet downloade deed"*, and
section 16.5 flagged that function as an unreconciled divergence. **Nobody has
read it.** That is still the single most valuable outstanding check on this
rail.

### 18.0a The queries, corrected

The earlier version of this section used `ops_alerts.type`. **The column is
`alert_type`.** That query would have errored.

```sql
-- What complained, and when. Read-only.
select alert_type, hour_bucket, left(detail, 300) as detail
  from public.ops_alerts
 where hour_bucket >= now() - interval '48 hours'
 order by hour_bucket desc, alert_type;
```

The types that mean the deed rail is in trouble: `webhook_error`,
`deed_pdf_unavailable`, `deed_pdf_not_stored`, `pandadoc_signature_rejected`,
`pandadoc_completed_unknown_document`, `pandadoc_livemode_mismatch`,
`deed_executed_after_refund`, `deed_delivery_target_unreadable`,
`deed_awaiting_staff_send`, `deed_stamp_partial`, `deed_sweep_failed`,
`deed_sweep_all_failed`, and the new `deed_completion_reconciled`.

```sql
-- Is any deed stuck right now? Read-only. Zero rows is healthy.
select * from public.deeds_awaiting_completion(interval '10 minutes', 1000);
```

### 18.1 What is on live, and what is deliberately not

**On live as of 15 October:**

- Migration `20261015000000`, applied by hand in the SQL editor (every statement
  is idempotent) with a row inserted into
  `supabase_migrations.schema_migrations` so a later `db push` skips it. It adds
  `applications.deed_status_checked_at` and `public.deeds_awaiting_completion`,
  granted to `service_role` only. It is purely additive and redefines nothing,
  so it cannot have reverted any of your migrations.
- `deed-sweep` version 10, `verify_jwt` false. It carries the completion arm:
  for every application still holding a document it believes unsigned, it asks
  PandaDoc for the real status and, where PandaDoc says completed, runs the
  webhook's own completion sequence from `_shared/deedCompletion.ts`.

**NOT deployed, and this is a correction to the earlier version of this
section, which said it had to go out in the same pass:**

- **`pandadoc-webhook`.** Live's copy is yours, not ours, it contains a
  `downloadPdf` that returns null, and nobody has read it. Deploying ours would
  overwrite it with no copy kept. **Do not deploy it until 16.5's curl has been
  run and whatever it carries is back in the repo as a commit.**

**Why sweep-only is safe even though live runs a different webhook.** Both
versions build the dedup key identically:

```ts
const evId = `${docId}:${status ?? type}`;
await service.from("pandadoc_events").insert({ id: evId, type });
```

and both call `apply_deed_executed({p_document_id, p_pdf_path})`. So the
`pandadoc_events` primary key is a real lock across the divergence, and the
sweep cannot double-deliver a signature the webhook is handling. The cost is
that two delivery implementations coexist until you reconcile the webhook.

**Nothing else was needed.** No new secret: everything the completion arm reads
was already required by the generation arm, which already sends email and
creates PandaDoc documents. No cron edit: `deed-sweep-hourly` runs `20 * * * *`
and posts `body := '{}'::jsonb`, so the new arm runs on the existing schedule.
No website change: the fix touches no file under `src/` except tests.

### 18.2 The runbook: recognising and recovering an abandoned claim

This is the part to keep. It applies to any deed, not just these two.

**The symptom.** An application sits at `status = 'paid'`,
`deed_state = 'awaiting_tenant'` with a `pandadoc_document_id`, while PandaDoc
shows the document completed. The agency chases; the tenant has already signed.

**Why it used to be permanent.** The dedup row is written *before* the work, so
any hard failure between the two leaves a claim with nothing behind it, and
PandaDoc will not send the event again.

**What fixes it.** `deed-sweep` now judges such a claim by its age.
`_shared/completionLock.ts` holds the decision, and it is unit tested rather
than asserted off the source. A claim younger than 15 minutes may have a live
request behind it and is left alone; an older one cannot, and the sweep adopts
it. Whether the work finished is already settled before that point, because
`deeds_awaiting_completion` only ever returns `status = 'paid'` rows whose
`deed_state` is not executed, voided or declined.

**The recovery, in order.** `$SECRET` is `ops_secrets.reminders_cron`.

1. Look first. This creates nothing, sends nothing and writes nothing, in both
   arms:

   ```
   curl -s -X POST "https://<ref>.supabase.co/functions/v1/deed-sweep" \
     -H "Content-Type: application/json" -H "x-reminders-secret: $SECRET" \
     -d '{"dryRun":true}' | jq .completion
   ```

   `wouldReconcile` names deeds a real run would issue. `blockedByFreshLock`
   names claims too young to step on. `stillOut` is the healthy case: PandaDoc
   agrees the document is not signed. `unreadable` means the status could not be
   read, and a failed read is never treated as "not signed".

2. **Check who each one would be delivered to before you act.** On 15 October
   both deeds were approved as "Regent deeds" and GR-20611 in fact delivered to
   `lettings@omniapropertygroup.com`. The deed goes to whoever
   `deed_delivery_target` resolves, which is the agency's ladder, not the one you
   have in mind:

   ```sql
   select guarantee_ref, (select string_agg(email, ', ')
            from public.deed_delivery_target(a.id)) as would_go_to
     from public.applications a
    where a.guarantee_ref in ('GR-XXXXX');
   ```

3. Then act, naming the refs so nothing else is touched:

   ```
   curl -s -X POST "https://<ref>.supabase.co/functions/v1/deed-sweep" \
     -H "Content-Type: application/json" -H "x-reminders-secret: $SECRET" \
     -d '{"refs":["GR-XXXXX"]}' | jq .completion
   ```

   A manual run needs `{"reconcile":true}` to act at all, unless `refs` is
   given; the cron is always real. Expect the refs under `reconciled`.

4. Confirm in the tables, not from the function's own word for it:

   ```sql
   select a.guarantee_ref, a.status, a.deed_state, a.deed_executed_at,
          a.executed_pdf_path, a.deed_delivered_at, a.deed_delivered_to,
          a.awaiting_staff_send,
          (select coalesce(o.metadata->>'size','MISSING') from storage.objects o
            where o.bucket_id = 'deeds' and o.name = a.executed_pdf_path) as pdf_bytes
     from public.applications a
    where a.guarantee_ref in ('GR-XXXXX');
   ```

   `pdf_bytes` matters on its own: `executed_pdf_path` being set does not prove
   the object exists, and a path pointing at nothing is a failure this code was
   written to avoid.

5. **Press Send deed to landlord** on each application. Automatic completion
   delivers to the agency and the tenant only. This has always been manual.

6. Expect one `deed_completion_reconciled` alert per deed. Read its detail: it
   states whether a `pandadoc_events` row already existed, which distinguishes
   "the webhook died holding its claim" from "the callback never arrived". Both
   deeds on 15 October reported the former.

**If `awaiting_staff_send` comes back true**, the deed is issued but delivery
resolved nobody. The **Send deed to agent** button on the application clears it.

**What a reconciliation does not do.** It does not fix HubSpot. Both signings on
15 October raised `hubspot_sync_error` with
`Cannot create object with type: p144519077_applicants ... missing: [full_name]`,
which was already failing for these applications before the recovery. The CRM
still shows them unsigned. That is a separate defect.
### 18.3 Pointing Test at its own PandaDoc sandbox

Test is creating real deeds in the live PandaDoc account (GR-20694, 20697,
20698, 20707 on 15 October), spending credits and posting webhooks to live.

**CONFIRMED FROM LIVE'S OWN ALERTS, 15 October.** This is no longer an
inference from the ref numbers. Live raised six
`pandadoc_completed_unknown_document` alerts between 05:00 and 10:00 UTC, each
naming a document it does not recognise:

```
TM4yUXctViXnFACToGWayQ   BGTCF8HZ3VDJLGyUMvHd3i   5jLb9B6iMPuEFxAtHYk499
Gaazw8dRghyVoo32HnHQvV   TLtcwtACez8TWzV8LAjdCW   gzYHFQFRBaVYiA5LYv5sua
```

`report_ops_incident` dedups one row per type per hour, so six alerts means at
least six and possibly many more.

**And it is worse than wasted credits.** Live refuses these correctly, because
they match no application here. Test never receives the callback, because the
subscription points at live. So **Test's own deeds are not being executed
anywhere at all**: a tenant signs in Test, and nothing records it, in either
project. The alert's own wording says this ("in which case that environment's
deeds are not being executed"), and that is the case we are in.

Those alerts are also the proof that **live runs OUR `pandadoc-webhook`**: that
alert type exists only in our code, and the 18 September `origin/main` version
raises no ops incidents at all.

**The code already supports a separate sandbox and needs no change.**
`_shared/livemodeCredentials.ts` resolves every third-party credential per
application: for `livemode = false` it reads `<NAME>_TEST` and, on a project
listed in `NON_PRODUCTION_REFS`, falls back to `<NAME>`. So the three secrets
it wants are `PANDADOC_API_KEY_TEST`, `PANDADOC_TEMPLATE_ID_TEST` and
`PANDADOC_WEBHOOK_SHARED_KEY_TEST`.

**First find out which of three things is actually happening**, because the fix
differs and only one of them is a configuration error:

```sql
-- Read-only. Run on whichever project Test uses.
select guarantee_ref, livemode, pandadoc_document_id, created_at
  from public.applications
 where guarantee_ref in ('GR-20694','GR-20697','GR-20698','GR-20707')
 order by guarantee_ref;
```

| if | then | fix |
| --- | --- | --- |
| `livemode` is **true** | These are LIVE applications. The live PandaDoc key is correct behaviour and no secret is wrong | Make Test create sandbox rows instead. A sandbox application is minted by a sandbox token, so this is about which API key or token Test uses, not about PandaDoc |
| `livemode` is **false** and Test runs on a project in `NON_PRODUCTION_REFS` | The one permitted fallback fired and resolved the base `PANDADOC_API_KEY`, which on that project has been set to the live account's key | Set `PANDADOC_API_KEY_TEST` and `PANDADOC_TEMPLATE_ID_TEST` on that project to the sandbox workspace's values. Better still, also replace that project's base `PANDADOC_API_KEY` with the sandbox key, so the fallback cannot reach the live account at all |
| `livemode` is **false** and Test runs on the live project | `PANDADOC_API_KEY_TEST` on live has been set to the live account's key | Replace it with the sandbox workspace's key |

**The sandbox workspace itself.** PandaDoc API keys are per workspace, so a
separate sandbox means a separate workspace (or a developer sandbox account):

1. Create the workspace, and in it create the Deed of Guarantee template. Note
   its template id; a template id from one workspace is not valid in another,
   which is why `PANDADOC_TEMPLATE_ID_TEST` exists as its own secret.
2. Create an API key in that workspace.
3. Add a webhook subscription in that workspace pointing at the Test project's
   `https://<test ref>.supabase.co/functions/v1/pandadoc-webhook`, subscribed
   to document state changes, with HMAC signing on and a shared key you then
   set as `PANDADOC_WEBHOOK_SHARED_KEY_TEST` on the Test project.
4. Set the three `_TEST` secrets on the Test project and redeploy nothing: edge
   functions read secrets at invocation.

**Why the shared key must be different from live's.** `verifyWebhook` tries
both configured keys and derives the mode from WHICHEVER ONE VERIFIED, because
nothing in a PandaDoc callback says which account sent it and anything in the
body would be attacker controlled. If the two keys are the same value, that
derivation collapses: `pandadocWebhookKeys` deliberately drops the test key
when it equals the live one, and every callback would then be read as live.

**One gap worth knowing about rather than fixing today.** Stripe keys are
checked by prefix, so an `sk_live_` key in a test slot is refused. PandaDoc
keys have no equivalent prefix, so nothing in the code can tell a live PandaDoc
key from a sandbox one. The `_TEST` secrets are the only thing separating the
two accounts, and a wrong value there fails silently by working.
