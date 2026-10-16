-- HUBSPOT GETS ONE OF THREE CHANNELS.
--
-- Live, 14 October: the referral sync 400ing on both of that day's referrals,
-- "Partner referral was not one of the allowed options: [Direct, Partner
-- Referral, Integration]" and the same for "Agent referral". The first differs
-- from an allowed option only in a capital letter.
--
-- Not a fault we introduced: GR-20607 sent "Partner referral" on 28 September
-- and was accepted. The option list was narrowed in HubSpot between then and
-- the 14th.
--
-- THE INTERNAL VOCABULARY IS NOT CHANGED BY THE FIX. application_channel still
-- returns 'Direct' / 'Provider hand-over' / 'Agent referral' / 'Partner
-- referral', because it is mirrored in src/data/channel.ts, read by
-- liveAnalytics.ts and by expiry-reminders. 20261015110000 translates at the
-- boundary instead, in hubspot_channel, which application_attribution feeds to
-- the sync and to nothing else.
--
-- Matt's rule: an agent or a partner referring through the PORTAL is a Partner
-- Referral; anything through the partner API is an Integration. Nothing on
-- applications records which, so the discriminator is the activity trail:
-- create-referral writes referral_created, create_referral_api writes nothing.

begin;
select plan(9);

insert into public.partners (id, slug, name, referencing_mode, partner_rate, agent_rate, is_house_route, refers_own_stock, partner_kind)
values ('9a000000-0000-0000-0000-000000000001', 'zzz-chan-supplier', 'ZZZ Chan Supplier', 'pre_referenced_open', 0.25, 0.10, false, false, 'supplier'),
       ('9a000000-0000-0000-0000-000000000002', 'opndoor-direct-zzz', 'ZZZ Direct', 'opndoor_referenced', 0.25, 0.10, true, true, 'agency');
insert into public.agencies (id, partner_id, name)
values ('9a000000-0000-0000-0000-00000000000a', '9a000000-0000-0000-0000-000000000001', 'ZZZ Chan Lettings'),
       ('9a000000-0000-0000-0000-00000000000b', '9a000000-0000-0000-0000-000000000002', 'ZZZ Direct Lettings');
insert into public.branches (id, agency_id, partner_id, name)
values ('9a000000-0000-0000-0000-0000000000b1', '9a000000-0000-0000-0000-00000000000a', '9a000000-0000-0000-0000-000000000001', 'Chan Park'),
       ('9a000000-0000-0000-0000-0000000000b2', '9a000000-0000-0000-0000-00000000000b', '9a000000-0000-0000-0000-000000000002', 'Direct Park');

/* assert_application_attributed (20260812180000) refuses an application on a
   non-house-route partner with neither a referrer nor an applicant, which is
   exactly right and which these fixtures have to satisfy. A referrer on the
   supplier's own estate is the cheap one: public.applicants FKs to
   public.users, so an applicant costs a user row anyway. */
-- public.users FKs to auth.users, so the auth row comes first: the pattern
-- a_decision_is_a_moment_not_a_flag.test.sql established.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values ('9a000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'zzz.chan@zzzchan.invalid', '', now(), now(), now());

insert into public.users (id, full_name, email, role, partner_id, status, sees_commission)
values ('9a000000-0000-0000-0000-0000000000ff', 'ZZZ Chan Referrer', 'zzz.chan@zzzchan.invalid',
        'referrer', '9a000000-0000-0000-0000-000000000001', 'active', false);

insert into public.applications (
  id, guarantee_ref, branch_id, agency_id, partner_id, referrer_id,
  tenant_title, tenant_first_name, tenant_last_name, tenant_dob, tenant_email, tenant_phone,
  prop_addr1, prop_city, prop_postcode, monthly_rent, fee_amount, tenancy_start,
  status, sent_at, livemode, referencing_mode, partner_rate, agent_rate
)
select ('9a000000-0000-0000-0000-0000000000' || suffix)::uuid, 'GR-CHAN-' || suffix,
       br, ag, pt, '9a000000-0000-0000-0000-0000000000ff',
       'Mr', 'Chan', nm, '1990-01-01', 'chan' || suffix || '@zzzchan.invalid', '07700 900900',
       '1 Chan Road', 'London', 'NW1 1CH', 1000, 692.31, current_date + 30,
       'sent', now() - interval '1 day', false, 'pre_referenced_open', 0.25, 0.10
from (values
  -- portal referral on a partner estate
  ('e1', 'Portal',   '9a000000-0000-0000-0000-0000000000b1'::uuid, '9a000000-0000-0000-0000-00000000000a'::uuid, '9a000000-0000-0000-0000-000000000001'::uuid),
  -- the same partner, pushed through the API: no activity row at all
  ('e2', 'Api',      '9a000000-0000-0000-0000-0000000000b1',       '9a000000-0000-0000-0000-00000000000a',       '9a000000-0000-0000-0000-000000000001'),
  -- a house route, which application_channel already calls Direct
  ('e3', 'Housely',  '9a000000-0000-0000-0000-0000000000b2',       '9a000000-0000-0000-0000-00000000000b',       '9a000000-0000-0000-0000-000000000002')
) v(suffix, nm, br, ag, pt);

-- Only the portal one gets the row create-referral writes.
insert into public.activity_log (application_id, kind, message, actor, visibility)
values ('9a000000-0000-0000-0000-0000000000e1', 'referral_created', 'Referral created and sent to the tenant.', 'ZZZ Agent', 'business');

-- ---------------------------------------------------------------------------
-- THE THREE OPTIONS, AND NOTHING ELSE.
-- ---------------------------------------------------------------------------
select is(public.hubspot_channel('9a000000-0000-0000-0000-0000000000e1'), 'Partner Referral',
  'an agent or partner referring through the portal is a Partner Referral');

select is(public.hubspot_channel('9a000000-0000-0000-0000-0000000000e2'), 'Integration',
  'and the same partner through the API is an Integration');

select is(public.hubspot_channel('9a000000-0000-0000-0000-0000000000e3'), 'Direct',
  'and a house route stays Direct, which HubSpot already allows');

/* THE DISCRIMINATOR HAS TO WORK WITHIN ONE PARTNER, which is why it is the
   activity trail and not the partner's estate: e1 and e2 share a partner, a
   branch and an agency, and differ only in how they arrived. A partner-level
   rule could not tell them apart at all. */
select isnt(public.hubspot_channel('9a000000-0000-0000-0000-0000000000e1'),
            public.hubspot_channel('9a000000-0000-0000-0000-0000000000e2'),
  'two referrals on the same partner are told apart by how they arrived');

-- ---------------------------------------------------------------------------
-- THE INTERNAL VOCABULARY IS UNTOUCHED. If this ever fails, analytics and the
-- client mirror in src/data/channel.ts have moved for the sake of a CRM field.
-- ---------------------------------------------------------------------------
select is(public.application_channel('9a000000-0000-0000-0000-0000000000e1'), 'Partner referral',
  'application_channel still speaks the internal vocabulary');

select is(public.application_channel('9a000000-0000-0000-0000-0000000000e3'), 'Direct',
  'and still calls a house route Direct');

-- ---------------------------------------------------------------------------
-- THE BOUNDARY IS WHAT THE SYNC READS, so it is what must be HubSpot-shaped.
-- ---------------------------------------------------------------------------
select is((select channel from public.application_attribution('9a000000-0000-0000-0000-0000000000e1')),
  'Partner Referral',
  'and application_attribution, which is all hubspot-sync reads, carries the HubSpot option');

-- ---------------------------------------------------------------------------
-- A PROPERTY, NOT A LIST OF CASES. Whatever else is in this database, the
-- channel sent to HubSpot is always one of the three it accepts. This is the
-- assertion that would have caught the live 400 before it happened.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.applications a
    where public.hubspot_channel(a.id) is not null
      and public.hubspot_channel(a.id) not in ('Direct', 'Partner Referral', 'Integration')),
  0,
  'no application anywhere resolves to a channel HubSpot would refuse');

/* AND THE OLD VALUES REALLY WOULD HAVE BEEN REFUSED, so the assertion above is
   not vacuous: three of the four internal values are not in HubSpot's set. */
select is(
  (select count(*)::int from (values ('Direct'),('Provider hand-over'),('Agent referral'),('Partner referral')) v(ch)
    where v.ch not in ('Direct', 'Partner Referral', 'Integration')),
  3,
  'three of the four internal channel names are not options HubSpot accepts');

select * from finish();
rollback;
