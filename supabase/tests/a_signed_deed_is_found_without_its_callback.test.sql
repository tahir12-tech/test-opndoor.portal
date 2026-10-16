-- A SIGNED DEED IS FOUND WITHOUT ITS CALLBACK.
--
-- GR-20611 and GR-20612 were completed in PandaDoc on the evening of 14 October
-- 2026 and live recorded neither. pandadoc_events holds a document.viewed for
-- 20612 and no completion, both rows still read status 'paid' / deed_state
-- 'awaiting_tenant' with deed_attempts 0 and no error, and completions have
-- arrived normally since. The callbacks were lost in flight, once.
--
-- The hourly sweep ran throughout and could not have helped:
-- deeds_awaiting_generation requires pandadoc_document_id IS NULL and deed_state
-- null or 'error', so a row with a document sitting at 'awaiting_tenant' is
-- excluded twice over. deeds_awaiting_completion is the question nobody was
-- asking, and the first assertion below is exactly the shape of those two rows.
--
-- WHAT IT MUST NOT RETURN matters as much as what it must, for the same reason
-- it does in a_paid_application_with_no_deed_is_found: every row it returns gets
-- a Deed of Guarantee issued against it and an executed deed emailed to an
-- agency and a tenant.

begin;
select plan(24);

insert into public.partners (id, slug, name, referencing_mode, partner_rate, agent_rate, is_house_route, refers_own_stock, partner_kind)
values ('97000000-0000-0000-0000-000000000001', 'zzz-recon', 'ZZZ Recon Estate', 'opndoor_referenced', 0.25, 0.10, true, true, 'agency');
insert into public.agencies (id, partner_id, name)
values ('97000000-0000-0000-0000-00000000000a', '97000000-0000-0000-0000-000000000001', 'ZZZ Recon Lettings');
insert into public.branches (id, agency_id, partner_id, name)
values ('97000000-0000-0000-0000-0000000000b1', '97000000-0000-0000-0000-00000000000a', '97000000-0000-0000-0000-000000000001', 'Recon Park');

/* Nine applications differing in exactly one property each, so a failure names
   the property and not the fixture. */
insert into public.applications (
  id, guarantee_ref, branch_id, agency_id, partner_id,
  tenant_title, tenant_first_name, tenant_last_name, tenant_dob, tenant_email, tenant_phone,
  prop_addr1, prop_city, prop_postcode, monthly_rent, fee_amount, tenancy_start,
  status, sent_at, paid_at, deed_sent_at, livemode, referencing_mode, partner_rate, agent_rate,
  pandadoc_document_id, deed_state, payment_state, deed_status_checked_at, deed_issued_at
)
select
  ('97000000-0000-0000-0000-0000000000' || suffix)::uuid, 'GR-RECON-' || suffix,
  '97000000-0000-0000-0000-0000000000b1', '97000000-0000-0000-0000-00000000000a', '97000000-0000-0000-0000-000000000001',
  'Mr', 'Recon', name, '1990-01-01', 'recon' || suffix || '@zzzrecon.test', '07700 900900',
  '1 Recon Road', 'London', 'NW1 1RC', 1000, 692.31, current_date + 30,
  st, now() - interval '5 days', now() - interval '2 days', sent, false, 'pre_referenced_open', 0.25, 0.10,
  doc, state, pay, checked,
  -- applications_status_dates: a 'deed' row must carry deed_issued_at. The one
  -- fixture at that status is the already-executed row.
  case when st = 'deed' then now() - interval '2 days' else null end
from (values
  -- suffix, name,       status,  doc,       state,             pay,        deed_sent_at,                  checked
  ('d1', 'Lostwebhook', 'paid',  'DOC-R1',  'awaiting_tenant', 'paid',     now() - interval '2 days',     null::timestamptz),
  ('d2', 'Stamppartial','paid',  'DOC-R2',  null,              'paid',     now() - interval '2 days',     null),
  ('d3', 'Executed',    'deed',  'DOC-R3',  'executed',        'paid',     now() - interval '2 days',     null),
  ('d4', 'Voided',      'paid',  'DOC-R4',  'voided',          'paid',     now() - interval '2 days',     null),
  ('d5', 'Declined',    'paid',  'DOC-R5',  'declined',        'paid',     now() - interval '2 days',     null),
  ('d6', 'Refunded',    'paid',  'DOC-R6',  'awaiting_tenant', 'refunded', now() - interval '2 days',     null),
  ('d7', 'Nodoc',       'paid',  null,      null,              'paid',     null,                          null),
  ('d8', 'Justsent',    'paid',  'DOC-R8',  'awaiting_tenant', 'paid',     now() - interval '4 minutes',  null),
  ('d9', 'Nosentstamp', 'paid',  'DOC-R9',  'awaiting_tenant', 'paid',     null,                          null)
) v(suffix, name, st, doc, state, pay, sent, checked);

select has_column('public', 'applications', 'deed_status_checked_at',
  'the sweep records when it last asked PandaDoc, which is what makes its per-run bound fair');

-- ---------------------------------------------------------------------------
-- WHAT IT FINDS.
-- ---------------------------------------------------------------------------
select ok(exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d1'),
  'a paid application holding a document it still believes is unsigned: the exact shape of GR-20611 and GR-20612');

/* AND THE SWEEP THAT ALREADY EXISTED CANNOT SEE IT, which is the whole reason
   this one had to be written. Asserted rather than described, so that if
   somebody later widens deeds_awaiting_generation to cover rows that already
   hold a document, this file says why that is not the fix: it would make the
   generation sweep create a SECOND PandaDoc document for a tenancy that already
   has a signed one. The two arms stay disjoint on purpose. */
select ok(not exists (select 1 from public.deeds_awaiting_generation(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d1'),
  'while the generation sweep cannot see it at all, which is why it ran every hour for a day and did not help');

-- The deed_stamp_partial row in _shared/pandadoc.ts: generation secured the
-- document id but could not write the surrounding columns, so deed_state is
-- null. It is signable, and before this it was the one row nobody could ever
-- reconcile from either end.
select ok(exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d2'),
  'and one whose deed_state was never written, which is the partially stamped row');

select ok(exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d9'),
  'and one with no deed_sent_at, which falls back to paid_at rather than being skipped for ever');

-- ---------------------------------------------------------------------------
-- WHAT IT MUST NOT FIND.
-- ---------------------------------------------------------------------------
select ok(not exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d3'),
  'not a deed already executed, or the sweep would issue and deliver a second time');

select ok(not exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d4'),
  'not a voided deed, which a person decided and a tenant cannot sign');

select ok(not exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d5'),
  'nor a declined one');

select ok(not exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d6'),
  'not a refunded application: the money went back, so the guarantee must not be issued');

select ok(not exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d7'),
  'not one with no document at all, which is deeds_awaiting_generation''s half of the estate');

select ok(not exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d8'),
  'and not one sent four minutes ago: pandadoc-webhook is probably handling it this second');

-- Same belt as the generation sweep, and for the same reason: the constraint
-- means the clause can never fire, so the fixture would be a row the database
-- will not hold. Asserted rather than simulated.
select throws_ok(
  $$update public.applications set withdrawn_at = now() where guarantee_ref = 'GR-RECON-d1'$$,
  '23514', null,
  'a paid application cannot be marked withdrawn at all, so the sweep never meets one');

-- ---------------------------------------------------------------------------
-- THE WINDOW AND THE CAP ARE ARGUMENTS.
-- ---------------------------------------------------------------------------
select ok(exists (select 1 from public.deeds_awaiting_completion(interval '1 minute', 1000) where guarantee_ref = 'GR-RECON-d8'),
  'the four-minute-old one is found against a one-minute window, so a caller that knows better can say so');

select is((select count(*)::int from public.deeds_awaiting_completion(interval '10 minutes', 1)), 1,
  'the cap is honoured, so one bad afternoon cannot fire a hundred status reads at once');

/* NEVER-ASKED FIRST, THEN LONGEST-SINCE-ASKED, which is what stops the bound
   being unfair. Ordered by age alone, a run of 25 would check the same 25
   oldest open deeds every hour and a deed signed this morning would sit behind
   a queue of deeds nobody is ever going to sign.

   A PROPERTY of the returned list, not a named row: this file runs against a
   database that holds open deeds of its own, so "my fixture is first" would be
   a claim about the rest of the table. */
update public.applications set deed_status_checked_at = now() - interval '1 hour' where guarantee_ref = 'GR-RECON-d1';
update public.applications set deed_status_checked_at = now() - interval '5 minutes' where guarantee_ref = 'GR-RECON-d2';

select is(
  (select count(*)::int from (
     select deed_status_checked_at as c, lag(deed_status_checked_at) over (order by rn) as prev
       from (select deed_status_checked_at, row_number() over () as rn
               from public.deeds_awaiting_completion(interval '10 minutes', 1000)) t
   ) u where prev is not null and (c is null or c < prev)),
  0,
  'and they come back never-asked first and then longest-since-asked');

-- ---------------------------------------------------------------------------
-- THE MISSED WEBHOOK, SIMULATED. d1 is a deed signed in PandaDoc that this
-- database never heard about. apply_deed_executed is what the sweep's shared
-- completion sequence calls once PandaDoc confirms the status, so running it
-- here is the state transition the sweep produces, start to finish.
-- ---------------------------------------------------------------------------
select is(public.apply_deed_executed('DOC-R1', '97000000-0000-0000-0000-0000000000d1/GR-RECON-d1.pdf'), 'executed',
  'the sweep executes the deed PandaDoc had already collected a signature for');

select is((select status from public.applications where guarantee_ref = 'GR-RECON-d1'), 'deed',
  'the application reaches Deed Issued, which is what the agency was waiting for');

select is((select deed_state from public.applications where guarantee_ref = 'GR-RECON-d1'), 'executed',
  'and its deed sub-state says executed rather than awaiting a tenant who has already signed');

select is((select executed_pdf_path from public.applications where guarantee_ref = 'GR-RECON-d1'),
  '97000000-0000-0000-0000-0000000000d1/GR-RECON-d1.pdf',
  'with the stored signed document attached, so every surface that offers a download has one');

-- AND IT LEAVES THE QUEUE. Without this the next hourly run would reconcile the
-- same deed again, which means a second delivery to the agency.
select ok(not exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-d1'),
  'and it leaves the candidate list, so the next hour does not deliver the same deed twice');

-- A REFUSAL IS NOT A FAILURE. d6 was refunded, so the deed must not be issued.
-- The sweep treats this as done and keeps its dedup row: retrying would refuse
-- again, and the incident apply_deed_executed records is what a person acts on.
select is(public.apply_deed_executed('DOC-R6', null), 'refunded',
  'a refunded application is refused rather than issued, even though the tenant signed');

-- ---------------------------------------------------------------------------
-- THE LOCK BETWEEN THE TWO PATHS. Both the webhook and the sweep insert this id
-- before doing any of the work, so whichever is second does nothing. It is what
-- makes running the sweep alongside a healthy webhook safe.
-- ---------------------------------------------------------------------------
insert into public.pandadoc_events (id, type) values ('DOC-R1:document.completed', 'document.completed');
select throws_ok(
  $$insert into public.pandadoc_events (id, type) values ('DOC-R1:document.completed', 'document.completed')$$,
  '23505', null,
  'the second path to reach a completion is refused by the primary key, so one signature is never delivered twice');

-- ---------------------------------------------------------------------------
-- A TOMBSTONE MUST NOT HIDE THE WORK.
--
-- GR-20611 and GR-20612 on live each carry a pandadoc_events row
-- `<document>:document.completed` that was committed and then abandoned: the
-- handler threw on `pdf.ok` before the branch that releases it, PandaDoc's
-- retry was deduped into a 200, and the deed was never executed.
--
-- So the candidate list must be decided by the APPLICATION and never by
-- pandadoc_events. It is today, because deeds_awaiting_completion does not
-- mention that table at all. This asserts it, because the tempting
-- "optimisation" is exactly the bug: joining pandadoc_events to skip rows that
-- already look claimed would hide every abandoned claim for ever, which is the
-- state these two deeds have been in since 14 October.
-- ---------------------------------------------------------------------------
insert into public.applications (
  id, guarantee_ref, branch_id, agency_id, partner_id,
  tenant_title, tenant_first_name, tenant_last_name, tenant_dob, tenant_email, tenant_phone,
  prop_addr1, prop_city, prop_postcode, monthly_rent, fee_amount, tenancy_start,
  status, sent_at, paid_at, deed_sent_at, livemode, referencing_mode, partner_rate, agent_rate,
  pandadoc_document_id, deed_state, payment_state
) values (
  '97000000-0000-0000-0000-0000000000da', 'GR-RECON-da',
  '97000000-0000-0000-0000-0000000000b1', '97000000-0000-0000-0000-00000000000a', '97000000-0000-0000-0000-000000000001',
  'Mr', 'Recon', 'Tombstone', '1990-01-01', 'reconda@zzzrecon.test', '07700 900900',
  '1 Recon Road', 'London', 'NW1 1RC', 1000, 692.31, current_date + 30,
  'paid', now() - interval '5 days', now() - interval '2 days', now() - interval '2 days',
  false, 'pre_referenced_open', 0.25, 0.10,
  'DOC-RDA', 'awaiting_tenant', 'paid'
);

-- The abandoned claim, aged so it is unambiguously past any invocation.
insert into public.pandadoc_events (id, type, received_at)
values ('DOC-RDA:document.completed', 'document_state_changed', now() - interval '20 hours');

select ok(exists (select 1 from public.pandadoc_events where id = 'DOC-RDA:document.completed'),
  'the abandoned claim is there, so the next assertion is not vacuous');

select ok(exists (select 1 from public.deeds_awaiting_completion(interval '10 minutes', 1000) where guarantee_ref = 'GR-RECON-da'),
  'and the application is STILL a candidate, because a committed claim is not evidence the deed was issued');

select * from finish();
rollback;
