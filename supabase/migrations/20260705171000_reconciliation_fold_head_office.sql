-- =====================================================================
-- #117 Reconciliation: a single-office agency's auto "[Agency], Head office"
-- branch no longer appears as its own queue item — it folds into the agency's
-- card (confirming the agency sweeps it, per confirm_org_entity). The queue thus
-- counts DECISIONS: one card per agency (+ its head office), one per real branch.
-- A new `folded_head_office` flag lets the card note the folded head office.
-- =====================================================================
drop function if exists public.reconciliation_queue();

create or replace function public.reconciliation_queue()
returns table (
  entity_id uuid, entity_type text, name text, parent text,
  created_by_name text, created_at timestamptz, referral_count bigint,
  match_name text, match_exact boolean, folded_head_office boolean
)
language sql security definer set search_path to '' stable
as $function$
  with pend as (
    select a.id, 'agency'::text as etype, a.name, null::text as parent, a.created_by, a.created_at, a.partner_id
    from public.agencies a where a.review_state = 'pending_review'
    union all
    select b.id, 'branch'::text as etype, b.name, pa.name as parent, b.created_by, b.created_at, b.partner_id
    from public.branches b join public.agencies pa on pa.id = b.agency_id
    where b.review_state = 'pending_review'
      -- fold the auto head-office branch of a still-pending agency into its card
      and not (pa.review_state = 'pending_review' and lower(b.name) = lower(pa.name || ', Head office'))
  )
  select
    p.id, p.etype, p.name, p.parent,
    coalesce(u.full_name, 'A referrer') as created_by_name,
    p.created_at,
    (select count(*) from public.applications ap
       where (p.etype = 'agency' and ap.agency_id = p.id) or (p.etype = 'branch' and ap.branch_id = p.id)) as referral_count,
    m.name as match_name,
    coalesce(m.exact, false) as match_exact,
    (p.etype = 'agency' and exists (
       select 1 from public.branches b
       where b.agency_id = p.id and b.review_state = 'pending_review'
         and lower(b.name) = lower(p.name || ', Head office'))) as folded_head_office
  from pend p
  left join public.users u on u.id = p.created_by
  left join lateral (
    select c.name, (lower(c.name) = lower(p.name)) as exact
    from (
      select a.name from public.agencies a where p.etype = 'agency' and a.review_state = 'confirmed' and a.partner_id = p.partner_id
      union all
      select b.name from public.branches b where p.etype = 'branch' and b.review_state = 'confirmed' and b.partner_id = p.partner_id
    ) c
    where lower(c.name) = lower(p.name)
       or lower(c.name) like '%' || lower(p.name) || '%'
       or lower(p.name) like '%' || lower(c.name) || '%'
    order by (lower(c.name) = lower(p.name)) desc
    limit 1
  ) m on true
  where public.is_aal2() and public.is_admin()
  order by p.created_at desc;
$function$;
revoke execute on function public.reconciliation_queue() from public, anon;
grant execute on function public.reconciliation_queue() to authenticated;
