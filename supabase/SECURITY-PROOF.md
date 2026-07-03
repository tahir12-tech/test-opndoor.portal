# Security proof (Checkpoint 4)

A runnable, self-contained document proving the two things that matter for
tenant financial data:

1. **MFA is required.** A password-only session (AAL1) can reach nothing. Only a
   verified TOTP code (AAL2) unlocks any data.
2. **Cross-partner isolation and role scoping are enforced by the database.** A
   Referrer at one partner cannot reach another partner's application by any
   means (URL, id, hand-written query), because the database refuses it. The
   front-end guards are convenience only; Row Level Security (RLS) is the
   boundary.

It also proves the permission rules (`canAmendTenancyStart`, `canSendDeed`, and
contact writes) are enforced in the database, not just the UI.

Work through Part A in the browser and Part C in SQL. Part B ties them together.

---

## Test accounts

All seeded users share the password `OpndoorDemo!2026`. Each enrols its own
authenticator on first login.

| Email | Name | Role | Partner |
|---|---|---|---|
| `maya.holloway@brackenhouse.co.uk` | Maya Holloway | opndoor admin (superadmin) | opndoor (all) |
| `tom.sefton@brackenhouse.co.uk` | Tom Sefton | Management | Rightmove |
| `priya.nair@brackenhouse.co.uk` | Priya Nair | Referrer | Rightmove |
| `greg.mason@brackenhouse.co.uk` | Greg Mason | Management | Zoopla |
| `hannah.pryce@brackenhouse.co.uk` | Hannah Pryce | Referrer | Zoopla |
| `owen.black@brackenhouse.co.uk` | Owen Black | Management | OnTheMarket |
| `ruth.findlay@brackenhouse.co.uk` | Ruth Findlay | Referrer | OnTheMarket |

Priya's own referrals at seed time: `GR-20418, GR-20455, GR-20489, GR-20518,
GR-19001, GR-19022, GR-19036`. Useful "not yours" references for the probes
below: `GR-20502` (Rightmove, another referrer), `GR-21010` (Zoopla),
`GR-22008` (OnTheMarket).

> Counts in this document are live. If you have created referrals while testing,
> the absolute numbers grow. The proofs are stated as invariants (for example
> "0 foreign-partner rows"), which hold regardless of the totals.

---

## Part A. Route and id reachability (browser)

Start the app (`cd opndoor-portal && npm run dev`) and sign in as each user.

### Route access (front-end guards)

| Route | Referrer | Management | opndoor admin |
|---|---|---|---|
| `/dashboard` | yes | yes | yes |
| `/applications` | yes (own only) | yes (their partner) | yes (all) |
| `/applications/:ref` | own only | their partner | all |
| `/new-application` | yes | yes | yes |
| `/agencies` | yes (partner, read; add on the fly) | yes (partner) | yes (all) |
| `/activity` | yes (own) | yes (partner) | yes (all) |
| `/help` | yes | yes | yes |
| `/users` | **redirected to /dashboard** | yes (partner users) | yes (all) |
| `/partners` | **redirected** | **redirected** | yes |
| `/reconciliation` | **redirected** | **redirected** | yes |

### The id probe (the important one)

Signed in as **Priya** (Referrer, Rightmove):

1. Open `/applications/GR-20418` (hers). You see the full record.
2. Open `/applications/GR-20502` (Rightmove, but not hers). You do **not** see
   GR-20502. The page falls back to one of your own records, because GR-20502 is
   not in the data the database returned to you.
3. Open `/applications/GR-21010` (Zoopla). Same: no Zoopla data reaches you.

The front-end fallback is a UX detail; the reason you cannot see those records is
that the database never sent them. Part C proves that directly.

> Defence in depth: even if someone forced the client role to "superadmin" (via
> dev tools), the admin-only screens would render but show only their own
> RLS-scoped data, and any privileged write would be refused by the database.
> The route guard is not the security boundary; the database is.

---

## Part B. MFA enforcement

**Browser:** sign in with a correct email and password but do **not** complete
the 6-digit code (close the tab at the code step, then reopen the app). You are
returned to the sign-in / verify step and reach no screen with data. A
password-only session is AAL1, and the database returns nothing at AAL1.

**Database proof:** see C2 below (same user, AAL1, returns 0 everywhere).

---

## Part C. Database proofs (authoritative)

Run these in the Supabase dashboard **SQL Editor** (or any psql connected to the
project). The editor connects as a privileged role that **bypasses RLS**, so each
block explicitly switches to the `authenticated` role and sets the JWT claims to
impersonate a user, exactly as a real request would arrive. Everything runs
inside a transaction that is rolled back, so nothing is changed.

### The "act as user" template

```sql
begin;
select set_config('request.jwt.claims',
  json_build_object(
    'sub', (select id from public.users where email = 'priya.nair@brackenhouse.co.uk'),
    'role', 'authenticated',
    'aal', 'aal2')::text, true);
set local role authenticated;

-- your queries here run exactly as this user would see them
select count(*) from public.applications;

reset role;
rollback;
```

Change the `email` and the `aal` value to impersonate any user at any assurance
level.

### C1. Referrer isolation (Priya, Rightmove, AAL2)

```sql
begin;
select set_config('request.jwt.claims', json_build_object('sub',
  (select id from public.users where email='priya.nair@brackenhouse.co.uk'),
  'role','authenticated','aal','aal2')::text, true);
set local role authenticated;
select
  (select count(*) from public.applications)                                              as apps_visible,
  (select count(*) from public.applications where referrer_id <> auth.uid())              as not_owned_visible,
  (select count(*) from public.applications a join public.partners p on p.id=a.partner_id
     where p.slug <> 'rightmove')                                                         as foreign_partner_apps,
  (select count(*) from public.partners)                                                  as partners_visible,
  (select count(*) from public.users)                                                     as users_visible;
reset role;
rollback;
```

Example output (seed): `apps_visible = 7, not_owned_visible = 0,
foreign_partner_apps = 0, partners_visible = 1, users_visible = 1`.
Invariant: **not_owned = 0** and **foreign_partner_apps = 0**.

### C2. MFA gate: the same user at AAL1 sees nothing

```sql
begin;
select set_config('request.jwt.claims', json_build_object('sub',
  (select id from public.users where email='priya.nair@brackenhouse.co.uk'),
  'role','authenticated','aal','aal1')::text, true);
set local role authenticated;
select
  (select count(*) from public.applications) as apps_at_aal1,
  (select count(*) from public.partners)     as partners_at_aal1,
  (select count(*) from public.users)        as users_at_aal1;
reset role;
rollback;
```

Output: `0, 0, 0`. Password alone unlocks nothing.

### C3. Management scoping (Tom, Rightmove, AAL2)

```sql
begin;
select set_config('request.jwt.claims', json_build_object('sub',
  (select id from public.users where email='tom.sefton@brackenhouse.co.uk'),
  'role','authenticated','aal','aal2')::text, true);
set local role authenticated;
select
  (select count(*) from public.applications)                                              as apps_visible,
  (select count(*) from public.applications a join public.partners p on p.id=a.partner_id
     where p.slug <> 'rightmove')                                                         as foreign_partner_apps,
  (select count(*) from public.partners)                                                  as partners_visible,
  (select count(*) from public.users)                                                     as users_visible;
reset role;
rollback;
```

Example output: `apps_visible = 22 (all Rightmove), foreign_partner_apps = 0,
partners_visible = 1, users_visible = 11 (Rightmove staff only, never opndoor
staff)`. Invariant: **foreign_partner_apps = 0**, **partners_visible = 1**.

### C4. Cross-partner referrer (Hannah, Zoopla, AAL2) cannot reach Rightmove

```sql
begin;
select set_config('request.jwt.claims', json_build_object('sub',
  (select id from public.users where email='hannah.pryce@brackenhouse.co.uk'),
  'role','authenticated','aal','aal2')::text, true);
set local role authenticated;
select
  (select count(*) from public.applications)                                    as apps_visible,
  (select count(*) from public.applications where guarantee_ref='GR-20418')     as can_see_rightmove_GR20418,
  (select count(*) from public.applications a join public.partners p on p.id=a.partner_id
     where p.slug <> 'zoopla')                                                  as foreign_partner_apps;
reset role;
rollback;
```

Output: `apps_visible = 5 (her own Zoopla), can_see_rightmove_GR20418 = 0,
foreign_partner_apps = 0`. She cannot reach a Rightmove application by its
reference, by id, or by any query.

### C5. opndoor admin (Maya, AAL2) sees everything

```sql
begin;
select set_config('request.jwt.claims', json_build_object('sub',
  (select id from public.users where email='maya.holloway@brackenhouse.co.uk'),
  'role','authenticated','aal','aal2')::text, true);
set local role authenticated;
select
  (select count(*) from public.applications) as apps_visible,
  (select count(*) from public.partners)     as partners_visible,
  (select count(*) from public.users)        as users_visible;
reset role;
rollback;
```

Example output: `apps_visible = 30 (all), partners_visible = 3, users_visible =
16`.

### C6. Permission rules in the database (amend / send)

Simulating Priya (Referrer). Each attempt is caught so all seven run. The amend
boundary is deed-state aware: an owning Referrer may amend while **Sent or
Paid-but-unexecuted** (`deed_state <> 'executed'`), but once the deed is executed
(`status = 'deed'` / `deed_state = 'executed'`) amends are Management/opndoor-admin
only. Send stays owner-scoped, resolved-recipient-only for Referrers.

```sql
begin;
select set_config('request.jwt.claims', json_build_object('sub',
  (select id from public.users where email='priya.nair@brackenhouse.co.uk'),
  'role','authenticated','aal','aal2')::text, true);
create temp table _t(test text, outcome text);
do $$
begin
  begin perform public.amend_tenancy_start((select id from public.applications where guarantee_ref='GR-20489'), date '2026-08-01');
    insert into _t values ('1. amend OWN sent (GR-20489)', 'ALLOWED (expected)');
  exception when others then insert into _t values ('1. amend OWN sent (GR-20489)', 'BLOCKED: '||sqlerrm); end;

  begin perform public.amend_tenancy_start((select id from public.applications where guarantee_ref='GR-20502'), date '2026-08-01');
    insert into _t values ('2. amend NON-owned sent (GR-20502)', 'ALLOWED (UNEXPECTED!)');
  exception when others then insert into _t values ('2. amend NON-owned sent (GR-20502)', 'BLOCKED (expected): '||sqlerrm); end;

  begin perform public.amend_tenancy_start((select id from public.applications where guarantee_ref='GR-20455'), date '2026-08-01');
    insert into _t values ('3. amend OWN paid-unexecuted (GR-20455)', 'ALLOWED (expected)');
  exception when others then insert into _t values ('3. amend OWN paid-unexecuted (GR-20455)', 'BLOCKED (UNEXPECTED!): '||sqlerrm); end;

  begin perform public.amend_tenancy_start((select id from public.applications where guarantee_ref='GR-20418'), date '2026-08-01');
    insert into _t values ('4. amend OWN executed deed (GR-20418)', 'ALLOWED (UNEXPECTED!)');
  exception when others then insert into _t values ('4. amend OWN executed deed (GR-20418)', 'BLOCKED (expected): '||sqlerrm); end;

  begin perform public.send_deed_to_agent((select id from public.applications where guarantee_ref='GR-20418'), null, false);
    insert into _t values ('5. send OWN deed (GR-20418)', 'ALLOWED (expected)');
  exception when others then insert into _t values ('5. send OWN deed (GR-20418)', 'BLOCKED: '||sqlerrm); end;

  begin perform public.send_deed_to_agent((select id from public.applications where guarantee_ref='GR-20322'), null, false);
    insert into _t values ('6. send NON-owned deed (GR-20322)', 'ALLOWED (UNEXPECTED!)');
  exception when others then insert into _t values ('6. send NON-owned deed (GR-20322)', 'BLOCKED (expected): '||sqlerrm); end;

  begin perform public.send_deed_to_agent((select id from public.applications where guarantee_ref='GR-20418'), 'oneoff@example.com', true);
    insert into _t values ('7. one-off recipient / save (GR-20418)', 'ALLOWED (UNEXPECTED!)');
  exception when others then insert into _t values ('7. one-off recipient / save (GR-20418)', 'BLOCKED (expected): '||sqlerrm); end;
end $$;
select * from _t order by test;
rollback;
```

Output:

| test | outcome |
|---|---|
| 1. amend OWN sent (GR-20489) | ALLOWED (expected) |
| 2. amend NON-owned sent (GR-20502) | BLOCKED (expected): not permitted |
| 3. amend OWN paid-unexecuted (GR-20455) | ALLOWED (expected) |
| 4. amend OWN executed deed (GR-20418) | BLOCKED (expected): amend not permitted for this role and status |
| 5. send OWN deed (GR-20418) | ALLOWED (expected) |
| 6. send NON-owned deed (GR-20322) | BLOCKED (expected): not permitted |
| 7. one-off recipient / save (GR-20418) | BLOCKED (expected): referrers may only send to the resolved contact and cannot save contacts |

### C7. Referrers cannot write contacts

```sql
begin;
select set_config('request.jwt.claims', json_build_object('sub',
  (select id from public.users where email='priya.nair@brackenhouse.co.uk'),
  'role','authenticated','aal','aal2')::text, true);
set local role authenticated;
do $$
begin
  insert into public.agent_contacts (agency_id, name, email, contact_role, is_primary)
  values ((select id from public.agencies where name='Foxglove Residential'), 'Injected', 'x@x.com', 'x', false);
  perform set_config('proof.result', 'ALLOWED (UNEXPECTED!)', true);
exception when others then
  perform set_config('proof.result', 'BLOCKED (expected): '||sqlerrm, true);
end $$;
reset role;
select current_setting('proof.result', true) as referrer_writes_contact;
rollback;
```

Output: `BLOCKED (expected): new row violates row-level security policy for
table "agent_contacts"`.

---

## Data reachability matrix (the authoritative layer)

Verified by the proofs above.

| Resource | Referrer (own partner) | Management (own partner) | Referrer/Mgmt other partner | opndoor admin |
|---|---|---|---|---|
| Own referrals | yes | yes (all in partner) | no | yes (all) |
| Another referrer's referral, same partner | no | yes | no | yes |
| **Another partner's referral (any id)** | **no** | **no** | **no** | yes |
| Partner records | own only | own only | own only | all |
| Users | self only | own partner only | self / own only | all |
| Agent contacts (read) | own partner | own partner | own partner | all |
| Agent contacts (write) | **no** | yes (own partner) | no | yes |
| Amend own Sent application | yes | yes | n/a | yes |
| Amend own Paid/Deed application | **no** | yes | n/a | yes |
| Amend another user's application | **no** | yes (own partner) | no | yes |
| Send own issued deed | yes (resolved contact only) | yes | n/a | yes |
| Send another user's deed | **no** | yes (own partner) | no | yes |
| **Any data with password only (AAL1)** | **no** | **no** | **no** | **no** |

---

## Summary

- MFA is required for all users and enforced at the database (AAL2 restrictive
  policy on every table). Password alone reaches nothing (C2, Part B).
- A Referrer sees only their own referrals; Management sees only their partner's
  estate; opndoor admin sees everything (C1, C3, C5).
- Cross-partner isolation holds by reference, id and query, because RLS filters
  every read (C4). The front-end route guards and the id fallback are
  convenience; the database is the boundary.
- The amend and send permission rules, and contact writes, are enforced in the
  database (C6, C7), matching `canAmendTenancyStart` / `canSendDeed`.
