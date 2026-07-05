-- #4 review fix: "Sent to Paid" in the digest was paid-in-window / sent-in-window,
-- two independent cohorts, so it could exceed 100% or read 0% while fees were
-- collected. Add sent_paid = of the referrals SENT in the window, how many have
-- since been paid, so the edge function can show a true, bounded cohort conversion.
drop function if exists public.partner_weekly_digest(timestamptz, timestamptz);

create or replace function public.partner_weekly_digest(p_start timestamptz, p_end timestamptz)
returns table(
  partner_id uuid, partner_name text, sent int, sent_paid int, paid int, fees numeric,
  deeds int, awaiting int, top_branch text, top_branch_fees numeric
)
language plpgsql security definer set search_path to '' as $function$
begin
  return query
  with base as (
    select a.partner_id, a.status, a.sent_at, a.paid_at, a.deed_issued_at,
           a.deed_state, a.monthly_rent, b.name as branch_name
    from public.applications a
    left join public.branches b on b.id = a.branch_id
  ),
  per_partner as (
    select p.id as pid, p.name as pname,
      count(*) filter (where base.status <> 'withdrawn' and base.sent_at >= p_start and base.sent_at < p_end)::int as v_sent,
      count(*) filter (where base.status <> 'withdrawn' and base.sent_at >= p_start and base.sent_at < p_end and base.paid_at is not null)::int as v_sent_paid,
      count(*) filter (where base.paid_at >= p_start and base.paid_at < p_end)::int as v_paid,
      coalesce(sum(base.monthly_rent) filter (where base.paid_at >= p_start and base.paid_at < p_end), 0) as v_fees,
      count(*) filter (where base.deed_issued_at >= p_start and base.deed_issued_at < p_end)::int as v_deeds,
      count(*) filter (where base.deed_state = 'awaiting_tenant')::int as v_awaiting
    from public.partners p
    left join base on base.partner_id = p.id
    group by p.id, p.name
  ),
  branch_agg as (
    select base.partner_id as pid, base.branch_name as bname,
      coalesce(sum(base.monthly_rent) filter (where base.paid_at >= p_start and base.paid_at < p_end), 0) as bf
    from base
    where base.branch_name is not null
    group by base.partner_id, base.branch_name
  ),
  top_branch as (
    select ba.pid, ba.bname, ba.bf,
      row_number() over (partition by ba.pid order by ba.bf desc, ba.bname asc) as rn
    from branch_agg ba
  )
  select pp.pid, pp.pname, pp.v_sent, pp.v_sent_paid, pp.v_paid, pp.v_fees, pp.v_deeds, pp.v_awaiting,
         tb.bname, tb.bf
  from per_partner pp
  left join top_branch tb on tb.pid = pp.pid and tb.rn = 1;
end $function$;
revoke execute on function public.partner_weekly_digest(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.partner_weekly_digest(timestamptz, timestamptz) to service_role;
