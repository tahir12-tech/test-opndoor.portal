-- =====================================================================
-- THE AGENCY ROUTE HAS NO PARTNER COMPANY.
--
-- Matt, 2026-10-15: "applications on the agency route (the opndoor-agents house
-- partner) must NOT be associated to any Opndoor/placeholder partner company in
-- HubSpot. They should link only to the agency's own company and branch (e.g.
-- Regent). Partner associations stay as they are for real partners (Reference
-- My Tenant, Lettings in a Box etc.)."
--
-- WHAT WAS HAPPENING. hubspot-sync's ensureAssoc looks up
-- hubspot_partner_map.partner_company_key, searches HubSpot for a company with
-- that crm_company_key, and when it finds none raises
--
--   partner company PARTNER:opndoor-agents does not exist in HubSpot,
--   so the PRIMARY partner association cannot be made
--
-- which is what live did at 16:46. The alert was correct and the remedy it
-- implies was wrong: the answer is not to create a placeholder company for a
-- house partner, it is to stop asking for one.
--
-- WHY A COLUMN RATHER THAN A SLUG IN THE CODE. The sync loads this table with
-- `select("*")`, so a new column arrives in `pm` with no change to the loading
-- code, and the decision becomes config like the rest of this module. A
-- hardcoded 'opndoor-agents' would be one line and would need a deploy the next
-- time a house partner is added.
--
-- WHY `partner_kind <> 'supplier'` AND NOT JUST opndoor-agents. A partner
-- company in HubSpot is a commercial counterparty: Rightmove, Lettings in a
-- Box, Reference My Tenant. The agency route, the direct rail and the
-- provider hand-over are all us, and none of them has one. Matt named the
-- agency route because it is the one with applications today; opndoor-direct
-- and referencing-partner have none, so nobody has met their version of this
-- alert yet, and setting all three now means nobody has to.
--
-- THE SKIP IS RECORDED, NOT SILENT. ensureAssoc writes the ledger key
-- `assoc:<application>:partner` with target 'assoc_partner_skipped', so the
-- work is never reconsidered, the replay in 20261006130000 cannot pick these
-- applications up for an association they must not have, and "why has this one
-- no partner company" has an answer in the table rather than an absence.
-- =====================================================================

alter table public.hubspot_partner_map
  add column if not exists associate_partner_company boolean not null default true;

comment on column public.hubspot_partner_map.associate_partner_company is
  'Whether an applicant on this partner should be associated to a partner COMPANY in HubSpot. False for every partner that is us: the agency route, the direct rail and the provider hand-over have no commercial counterparty, so asking HubSpot for one only produces a config-gap alert. See 20261015130000.';

/* A partner company is a commercial counterparty. Only a supplier has one. */
update public.hubspot_partner_map m
   set associate_partner_company = false, updated_at = now()
 where exists (
   select 1 from public.partners p
    where p.id = m.partner_id
      and coalesce(p.partner_kind, '') <> 'supplier')
   and m.associate_partner_company;

/* AND EVERY PARTNER AFTER THEM, or the next house partner rediscovers this.
   The trigger is otherwise unchanged from 20261005250000: same insert, same
   conflict behaviour, same reactivation on update. */
create or replace function public.hubspot_seed_partner_map()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  insert into public.hubspot_partner_map (partner_id, partner_slug, hs_partner_id,
                                          partner_company_key, associate_partner_company)
  values (new.id, new.slug, new.slug, 'PARTNER:' || new.slug,
          coalesce(new.partner_kind, '') = 'supplier')
  on conflict (partner_id) do update set
    partner_slug = excluded.partner_slug, hs_partner_id = excluded.hs_partner_id,
    partner_company_key = excluded.partner_company_key,
    /* Recomputed on update too: a partner that changes kind changes whether it
       has a counterparty, and leaving the old answer behind is how the agency
       route got a placeholder company asked for in the first place. */
    associate_partner_company = excluded.associate_partner_company,
    active = true, updated_at = now();
  return new;
end $function$;
