-- #12 (owner ruling): the referrer leaderboard must rank by fees collected (net of
-- refunds) PRIMARY, referral count secondary and tiebreak, then name. It previously
-- sorted by referral count, so a £0 referrer could outrank a £2k one. Ranking uses
-- ACTUAL net fees even in 'rankings' mode (where the amounts themselves are hidden).
-- #13 Expired referrals are excluded from refs alongside withdrawn.
create or replace function public.referrer_league(p_start timestamptz, p_end timestamptz)
returns table(name text, refs integer, fees numeric, is_self boolean)
language plpgsql security definer set search_path to ''
as $function$
declare pid uuid := public.app_partner(); me uuid := auth.uid(); v_mode text;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if pid is null then return; end if;
  select referrer_leaderboard_mode into v_mode from public.partners where id = pid;
  v_mode := coalesce(v_mode, 'full');

  if v_mode = 'private' then
    return query
    select coalesce(u.full_name, 'You'),
           (select count(*)::int from public.applications a
              where a.partner_id = pid and a.referrer_id = me and a.status not in ('withdrawn','expired') and a.sent_at between p_start and p_end),
           (select coalesce(sum(a.monthly_rent), 0) from public.applications a
              where a.partner_id = pid and a.referrer_id = me and a.paid_at between p_start and p_end and a.payment_state is distinct from 'refunded'),
           true
    from public.users u where u.id = me;
    return;
  end if;

  return query
  with agg as (
    select a.referrer_id as rid,
           count(*) filter (where a.status not in ('withdrawn','expired') and a.sent_at between p_start and p_end) as ct,
           coalesce(sum(a.monthly_rent) filter (where a.paid_at between p_start and p_end and a.payment_state is distinct from 'refunded'), 0) as amt
    from public.applications a
    where a.partner_id = pid and a.referrer_id is not null
    group by a.referrer_id
  ),
  peers as (
    select u.full_name as rname, agg.ct::int as rrefs,
           case when v_mode = 'rankings' then 0::numeric else agg.amt end as rfees,
           agg.amt as ramt, (agg.rid = me) as rself, agg.rid as rrid
    from agg join public.users u on u.id = agg.rid
    where u.role <> 'superadmin' and agg.ct > 0
  ),
  self_row as (
    select coalesce(u.full_name, 'You') as rname,
           (select count(*)::int from public.applications a
              where a.partner_id = pid and a.referrer_id = me and a.status not in ('withdrawn','expired') and a.sent_at between p_start and p_end) as rrefs,
           (select coalesce(sum(a.monthly_rent), 0) from public.applications a
              where a.partner_id = pid and a.referrer_id = me and a.paid_at between p_start and p_end and a.payment_state is distinct from 'refunded') as ramt,
           true as rself, me as rrid
    from public.users u where u.id = me
  )
  select x.rname, x.rrefs, x.rfees, x.rself
  from (
    select p.rname, p.rrefs, p.rfees, p.ramt, p.rself, p.rrid from peers p where p.rrid <> me
    union all
    select s.rname, s.rrefs, case when v_mode = 'rankings' then 0::numeric else s.ramt end as rfees, s.ramt, s.rself, s.rrid from self_row s
  ) x
  order by x.ramt desc, x.rrefs desc, x.rname asc;
end $function$;
revoke execute on function public.referrer_league(timestamptz, timestamptz) from public, anon;
grant execute on function public.referrer_league(timestamptz, timestamptz) to authenticated;