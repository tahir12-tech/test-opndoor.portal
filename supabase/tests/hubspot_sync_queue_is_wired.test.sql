-- THE HUBSPOT SYNC QUEUE IS WIRED TO EVERY PARTNER IT DRAINS.
--
-- Reported as a recurring fault on the live portal: "a HubSpot sync error".
-- Two database properties decide whether that fault is possible, and neither
-- was asserted anywhere.
--
-- ONE, THE SIGNATURE. 20260812030000 drops the four-argument
-- hubspot_pending_events and creates a five-argument one, deliberately, so
-- that a deployment older than the migration fails loudly instead of quietly
-- draining an unpartitioned queue. That is the right call and it makes the
-- deploy ORDER load-bearing: migration and function together, function never
-- behind. The assertions below are the paper version of that order. They also
-- refuse a re-added overload, which would be worse than either state: an
-- un-updated caller would resolve to the old unpartitioned function and the
-- head-of-line blocking would come back with nothing on the surface to show.
--
-- TWO, THE PARTNER MAP, WHICH IS THE ACTUAL FAULT. hubspot-sync makes the
-- PRIMARY applicant-to-partner association from hubspot_partner_map. The seed
-- migration 20260705150500 filled that table from `partners` as it stood on
-- 2026-07-05 and nothing has filled it since. The per-partner cursor work
-- added a trigger that seeds hubspot_sync_cursor_partner on partner insert and
-- gave it NO companion for the map. So every partner created after the seed
-- has a cursor, is drained on every run, produces events, and has no map row.
-- On dev that is all seven of them, and the assertions below are consequently
-- RED: that is the fault, stated as a property, rather than a passing test
-- written after the fact. They go green when the map is seeded and given the
-- same insert trigger the cursor has.
--
-- The edge function no longer THROWS on this (a throw stopped that partner's
-- queue for ever); it gates the association and keeps draining. Gating stops
-- the outage. It does not make the association appear, which is what these
-- assertions are for.

begin;
select plan(16);

-- ---------------------------------------------------------------------------
-- The signature the deployed function calls, and only that one.
-- ---------------------------------------------------------------------------
select has_function('public', 'hubspot_pending_events',
  array['uuid', 'timestamp with time zone', 'uuid', 'text[]', 'integer'],
  'the partitioned five-argument hubspot_pending_events exists');

select hasnt_function('public', 'hubspot_pending_events',
  array['timestamp with time zone', 'uuid', 'text[]', 'integer'],
  'the unpartitioned four-argument signature is gone, so no caller can resolve to it');

select ok(has_function_privilege('service_role',
  'public.hubspot_pending_events(uuid, timestamptz, uuid, text[], integer)', 'execute'),
  'service_role can read the queue, which is the only caller that should');

select ok(not has_function_privilege('authenticated',
  'public.hubspot_pending_events(uuid, timestamptz, uuid, text[], integer)', 'execute'),
  'a signed-in user cannot read another partner''s whole application rows through it');

select ok(not has_function_privilege('anon',
  'public.hubspot_pending_events(uuid, timestamptz, uuid, text[], integer)', 'execute'),
  'anon cannot read the queue');

-- ---------------------------------------------------------------------------
-- Every partner the sync drains can actually be synced.
--
-- RED TODAY. This is the fault: a cursor without a map row is a partner whose
-- every event fails on the association step, for ever, with one ops-alert in
-- the first hour and silence after it.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from public.hubspot_sync_cursor_partner c
     join public.partners p on p.id = c.partner_id
     left join public.hubspot_partner_map m on m.partner_id = c.partner_id and m.active
    where m.partner_id is null),
  0,
  'every partner with a sync cursor has an active hubspot_partner_map row');

-- ---------------------------------------------------------------------------
-- And the mechanism behind it, so the fix is a trigger rather than a one-off
-- backfill that the next partner walks straight back out of.
-- ---------------------------------------------------------------------------
insert into public.partners (id, slug, name, referencing_mode, partner_rate, agent_rate, is_house_route, refers_own_stock, partner_kind)
values ('92000000-0000-0000-0000-000000000001', 'zzz-hubspot', 'ZZZ HubSpot', 'pre_referenced_open', 0.25, 0.10, true, true, 'supplier');

select ok(
  exists (select 1 from public.hubspot_sync_cursor_partner where partner_id = '92000000-0000-0000-0000-000000000001'),
  'a new partner is given a sync cursor, so the sync starts draining it immediately');

select ok(
  exists (select 1 from public.hubspot_partner_map where partner_id = '92000000-0000-0000-0000-000000000001' and active),
  'a new partner is given a hubspot_partner_map row, so what is drained can be synced');

-- ---------------------------------------------------------------------------
-- The ledger can carry the bounded-retry state the function now writes, with
-- no schema change: one row per failed attempt, one row when the event is
-- parked. Asserted here because the whole point of counting attempts in the
-- ledger rather than a new column was that the ledger already allows it.
-- ---------------------------------------------------------------------------
insert into public.hubspot_sync_events (id, event_id, target, application_id) values
  ('fail:92000000-0000-0000-0000-0000000000ee:1', '92000000-0000-0000-0000-0000000000ee', 'failed', null),
  ('fail:92000000-0000-0000-0000-0000000000ee:2', '92000000-0000-0000-0000-0000000000ee', 'failed', null),
  ('dead:92000000-0000-0000-0000-0000000000ee',   '92000000-0000-0000-0000-0000000000ee', 'dead_letter', null);

select is(
  (select count(*)::int from public.hubspot_sync_events
    where event_id = '92000000-0000-0000-0000-0000000000ee' and target = 'failed'),
  2,
  'failed attempts accumulate per event, which is what bounds the retry');

select is(
  (select count(*)::int from public.hubspot_sync_events
    where event_id = '92000000-0000-0000-0000-0000000000ee' and target = 'dead_letter'),
  1,
  'a parked event is recorded by name, so it can be replayed rather than lost');

-- ---------------------------------------------------------------------------
-- AN APPLICANT CAN BE CREATED BY ANY EVENT.
--
-- Live, 15 October 2026: "Cannot create object with type:
-- p144519077_applicants. The following required properties were missing:
-- [full_name]", on a deed_signed event for GR-20611 and GR-20612. HubSpot
-- enforces required properties on a CREATE and not on an update, so its own
-- wording says the Applicant did not exist, and full_name was mapped to the
-- referral event alone. Every event after the referral silently assumed the
-- referral had already created the record.
--
-- Asserted against the MAPPING rather than against hubspot-sync, because the
-- filter is a strict array membership test (index.ts:653) and the mapping is
-- the whole of the decision. 20261015100000 is the correction.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.hubspot_field_map
    where object = 'applicant' and hs_property = 'full_name' and source = 'full_name'
      and events @> array['referral','fee_paid','deed_issued']::text[]),
  1,
  'full_name rides the referral, the payment AND the deed, so whichever event lands first can create the applicant');

/* AND THE EVENT NAME IS THE INTERNAL ONE. activity_log.kind 'deed_signed' maps
   to the event 'deed_issued' (hubspot-sync/index.ts:72), so a mapping that
   named 'deed_signed' would read as correct and match nothing. This is the
   mistake the first explanation of the live failure made. */
select ok(
  not exists (select 1 from public.hubspot_field_map
               where object = 'applicant' and 'deed_signed' = any(events)),
  'and no mapping names deed_signed, which is the activity kind and never an event');

-- ---------------------------------------------------------------------------
-- THE AGENCY ROUTE HAS NO PARTNER COMPANY.
--
-- Live, 15 October, 16:46: "partner company PARTNER:opndoor-agents does not
-- exist in HubSpot, so the PRIMARY partner association cannot be made". The
-- alert was right and the remedy it implies was wrong. Matt: applications on
-- the agency route "must NOT be associated to any Opndoor/placeholder partner
-- company in HubSpot. They should link only to the agency's own company and
-- branch". 20261015130000 makes that config rather than code.
-- ---------------------------------------------------------------------------
select has_column('public', 'hubspot_partner_map', 'associate_partner_company',
  'whether a partner has a company in HubSpot is config, not a slug in the sync');

/* A partner company is a commercial counterparty, so only a supplier has one.
   Asserted as a PROPERTY over whatever partners this database holds, which is
   what would have caught the live alert: no partner that is US should be
   asking HubSpot for a company. */
select is(
  (select count(*)::int from public.hubspot_partner_map m
     join public.partners p on p.id = m.partner_id
    where m.associate_partner_company
      and coalesce(p.partner_kind,'') <> 'supplier'),
  0,
  'no agency-route, direct-rail or hand-over partner asks HubSpot for a partner company');

select ok(
  (select count(*)::int from public.hubspot_partner_map m
     join public.partners p on p.id = m.partner_id
    where m.associate_partner_company and p.partner_kind = 'supplier') > 0,
  'while real partners still do, which is the half that must not change');

/* AND EVERY PARTNER AFTER THEM. The trigger seeds a map row on insert, so
   without this the next house partner rediscovers the whole thing. */
insert into public.partners (id, slug, name, referencing_mode, partner_rate, agent_rate, is_house_route, refers_own_stock, partner_kind)
values ('9b000000-0000-0000-0000-000000000001', 'zzz-new-house', 'ZZZ New House', 'opndoor_referenced', 0.25, 0.10, true, true, 'agency');

select is(
  (select associate_partner_company from public.hubspot_partner_map
    where partner_id = '9b000000-0000-0000-0000-000000000001'),
  false,
  'and a partner created after this migration is seeded with the right answer');

select * from finish();
rollback;
