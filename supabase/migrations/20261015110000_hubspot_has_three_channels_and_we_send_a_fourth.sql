-- =====================================================================
-- HUBSPOT HAS THREE CHANNELS AND WE WERE SENDING A FOURTH.
--
-- Live, 14 October, the referral sync 400ing on both of that day's referrals:
--
--   GR-20611: "Partner referral was not one of the allowed options:
--              [Direct, Partner Referral, Integration]"
--   GR-20612: "Agent referral was not one of the allowed options:
--              [Direct, Partner Referral, Integration]"
--
-- THE FIRST ONE DIFFERS FROM AN ALLOWED OPTION ONLY IN A CAPITAL LETTER.
--
-- AND IT IS NOT A FAULT WE INTRODUCED. GR-20607 sent "Partner referral" on
-- 28 September and HubSpot accepted it; GR-20602 to GR-20607 all synced
-- cleanly. The same value was refused on 14 October, so that property's option
-- list was narrowed in HubSpot between those dates and our values were correct
-- until it moved under them. Recorded because it decides where the fix goes:
-- we are conforming to a changed contract, not correcting a mistake.
--
-- WHAT public.application_channel RETURNS, and must go on returning: 'Direct',
-- 'Provider hand-over', 'Agent referral', 'Partner referral'. That is the
-- INTERNAL vocabulary. It is mirrored in the client (src/data/channel.ts, with
-- its own test), read by src/data/liveAnalytics.ts and by the expiry-reminders
-- function. Changing those strings to satisfy a HubSpot property would move
-- analytics and reminder behaviour, which is a large blast radius for a field
-- in a CRM.
--
-- SO THE TRANSLATION GOES AT THE BOUNDARY. public.application_attribution is
-- that boundary: hubspot-sync/index.ts:660 is its only caller anywhere in the
-- tree, so what it returns is seen by HubSpot and by nothing else.
--
-- THE RULE, from Matt, 2026-10-15: "anything referred by an agent or a partner
-- through the portal goes to HubSpot as Partner Referral. Anything that came in
-- through the partner API goes as Integration."
--
-- AND THE DISCRIMINATOR IS NOT A COLUMN, because there is not one. Nothing on
-- public.applications records how a referral arrived; create_referral_api
-- inserts the same columns the portal does. What differs is the activity trail:
-- create-referral writes a `referral_created` row and create_referral_api
-- writes no activity row at all. On live all nine applications carry that row,
-- which is both the proof that the discriminator works and the statement that
-- nothing has yet arrived through the API.
--
-- A created_via column would be better and is not worth a code deploy and a
-- backfill today. If one is ever added, this function is where it belongs.
-- =====================================================================

create or replace function public.hubspot_channel(p_application uuid)
returns text
language sql stable security definer set search_path to ''
as $function$
  select case
    -- The direct rail, and any house route that is not the hand-over.
    -- application_channel already resolves both to 'Direct', which HubSpot
    -- allows unchanged.
    when public.application_channel(p_application) = 'Direct' then 'Direct'
    -- Typed into the portal, by one of our agents or by a partner's own staff.
    when exists (select 1 from public.activity_log l
                  where l.application_id = p_application
                    and l.kind = 'referral_created')
      then 'Partner Referral'
    /* Everything else reached us machine to machine: the partner API, and the
       Rightmove hand-over rail, whose internal channel is 'Provider hand-over'
       and which has no allowed option of its own. 'Integration' is the honest
       one of the three for it. Flagged to Matt rather than decided quietly,
       because the hand-over rail has no applications on live today and so
       nobody has had to have an opinion yet. */
    else 'Integration'
  end
$function$;

comment on function public.hubspot_channel(uuid) is
  'The HubSpot "channel" option for an application: Direct, Partner Referral or Integration, which is the whole of that property''s option set. public.application_channel remains the internal vocabulary and is deliberately not changed by this; see 20261015110000.';

/* Nothing a browser holds may call it. It is reached only from inside
   application_attribution, which is SECURITY DEFINER and owned by the same
   role, so it needs no grant of its own. */
revoke all on function public.hubspot_channel(uuid) from public, anon, authenticated;

-- The boundary, repointed. Everything else about it is unchanged, including the
-- inner join to agencies: an application with no agency returns no row at all,
-- and the sync simply omits the attribution properties for it.
create or replace function public.application_attribution(p_application uuid)
returns table (channel text, brand_name text, group_name text, group_id uuid)
language sql stable security definer set search_path to '' as $$
  select
    public.hubspot_channel(a.id),
    ag.name,
    coalesce(g.name, ag.group_name),
    g.id
  from public.applications a
  join public.agencies ag on ag.id = a.agency_id
  left join public.agency_groups g on g.id = ag.group_id
  where a.id = p_application
$$;

comment on function public.application_attribution(uuid) is
  'What HubSpot is told about where an application came from. Its `channel` column is HubSpot''s option set (Direct / Partner Referral / Integration) and NOT public.application_channel''s internal vocabulary; 20261015110000 separated the two. hubspot-sync is its only caller.';
