-- =====================================================================
-- AN APPLICANT CAN BE CREATED BY ANY EVENT, NOT ONLY BY ITS REFERRAL.
--
-- Live, 15 October 2026, twice within a minute of each other:
--
--   hubspot-sync deed_signed GR-20611 (attempt 1): HubSpot POST
--   /crm/v3/objects/2-203764825/batch/upsert -> 400 "Cannot create object with
--   type: p144519077_applicants. The following required properties were
--   missing: [full_name]"
--
-- THE WORD THAT MATTERS IS "CREATE". HubSpot enforces required properties when
-- it CREATES an object and not when it updates one, so its own wording says the
-- Applicant did not exist and the upsert fell to the create path. A create has
-- to satisfy the object's required properties out of whatever the payload
-- carries, and full_name was mapped to the referral event alone
-- (20260705150500_hubspot_sync_seed.sql:56, events = '{referral}').
--
-- hubspot-sync filters applicant properties with a strict array membership
-- test, `r.events.includes(eventType)` at index.ts:653, so an events array that
-- does not name the current event means the property is simply absent. Note
-- that '{}' is therefore "never", not "always": the two applicant rows seeded
-- with '{}' (brand_name, group_name) are never sent at all, which is a separate
-- matter and is deliberately not touched here.
--
-- SO THE ORDERING DEPENDENCY IS THE FAULT. Every event after the referral
-- assumed the referral had already created the record. When the referral's own
-- sync fails, and on live both of these had failed hours earlier, every
-- subsequent event becomes a create that cannot succeed, and each one then
-- parks after its retries. Carrying the identity property on every event
-- removes the assumption: whichever event arrives first can create the record.
--
-- WHY NOT hs_pipeline TOO, which is the other property a create plausibly
-- wants: HubSpot lists every missing required property, and it listed only
-- full_name. Adding more on a guess would be a change nobody measured.
--
-- The seven names are exactly the distinct values of KIND_TO_EVENT in
-- supabase/functions/hubspot-sync/index.ts. No deploy is needed: hubspot-sync
-- re-reads this table on every run (index.ts:226).
--
-- THIS REPAIRS THE FUTURE AND NOT THE PAST. The two events already parked are
-- past their partner's cursor and will not reach HubSpot until they are
-- replayed; 20261006130000 is the pattern for that, and the replay is a
-- deliberate act rather than something a migration should do behind anyone.
-- =====================================================================

update public.hubspot_field_map
   set events = array['referral','fee_paid','deed_issued','delivered',
                      'refund','withdrawn','tenancy_amend']::text[]
 where object = 'applicant'
   and hs_property = 'full_name'
   and source = 'full_name';

do $$
declare v_events text[];
begin
  select events into v_events
    from public.hubspot_field_map
   where object = 'applicant' and hs_property = 'full_name' and source = 'full_name';

  if v_events is null then
    -- Not an error worth failing a migration over: a database that has never
    -- been seeded with the field map has nothing to correct. Said out loud so a
    -- silent no-op is not mistaken for a successful repair.
    raise notice 'hubspot_field_map has no applicant/full_name row; nothing to correct';
  elsif not ('deed_issued' = any(v_events)) then
    raise exception 'applicant/full_name still does not carry deed_issued: %', v_events;
  else
    raise notice 'applicant/full_name now carries % events', cardinality(v_events);
  end if;
end $$;
