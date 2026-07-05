-- Review fix (#5): prev_r ranked by `fees desc` only, while curr_r ranks by
-- `fees desc, nm asc`. Among tied (esp. fees=0) referrers the prior rank was then
-- nondeterministic, producing a spurious rank delta and a fabricated "climber".
-- Give BOTH windows the same deterministic name tiebreak.
create or replace function public.partner_weekly_climbers(
  p_curr_start timestamptz, p_curr_end timestamptz, p_prev_start timestamptz, p_prev_end timestamptz
) returns table(partner_id uuid, climber_name text, climber_delta int)
language plpgsql security definer set search_path to '' as $function$
begin
  return query
  with curr as (
    select a.partner_id as pid, a.referrer_id as rid, u.full_name as nm,
      coalesce(sum(a.monthly_rent) filter (where a.paid_at >= p_curr_start and a.paid_at < p_curr_end and a.payment_state is distinct from 'refunded'), 0) as fees,
      count(*) filter (where a.status not in ('withdrawn','expired') and a.sent_at >= p_curr_start and a.sent_at < p_curr_end) as sent
    from public.applications a join public.users u on u.id = a.referrer_id
    where a.referrer_id is not null and u.role <> 'superadmin'
    group by a.partner_id, a.referrer_id, u.full_name
  ),
  prev as (
    select a.partner_id as pid, a.referrer_id as rid, u.full_name as nm,
      coalesce(sum(a.monthly_rent) filter (where a.paid_at >= p_prev_start and a.paid_at < p_prev_end and a.payment_state is distinct from 'refunded'), 0) as fees
    from public.applications a join public.users u on u.id = a.referrer_id
    where a.referrer_id is not null and u.role <> 'superadmin'
    group by a.partner_id, a.referrer_id, u.full_name
  ),
  curr_r as (select pid, rid, nm, fees, sent, row_number() over (partition by pid order by fees desc, nm asc) as rnk from curr),
  prev_r as (select pid, rid, row_number() over (partition by pid order by fees desc, nm asc) as rnk from prev),
  moved as (
    select c.pid, c.nm, (p.rnk - c.rnk) as delta
    from curr_r c join prev_r p on p.pid = c.pid and p.rid = c.rid
    where (c.fees > 0 or c.sent > 0) and (p.rnk - c.rnk) > 0
  ),
  top as (select pid, nm, delta, row_number() over (partition by pid order by delta desc, nm asc) as rn from moved)
  select pid, nm, delta::int from top where rn = 1;
end $function$;
revoke execute on function public.partner_weekly_climbers(timestamptz, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.partner_weekly_climbers(timestamptz, timestamptz, timestamptz, timestamptz) to service_role;
