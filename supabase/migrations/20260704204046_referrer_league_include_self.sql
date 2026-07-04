-- #87 The referrer leaderboard must always include the viewing referrer's own
-- row (highlighted, even at zero referrals). The prior referrer_league dropped a
-- caller with no in-period referrals via `agg.refs > 0`, and a brand-new referrer
-- is absent from the aggregate entirely. Rework the full/rankings branch to UNION
-- the caller's own row from public.users so it is always present exactly once.
-- The private branch (already self-only) and the mode enforcement are unchanged.
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
              where a.partner_id = pid and a.referrer_id = me and a.sent_at between p_start and p_end),
           (select coalesce(sum(a.monthly_rent), 0) from public.applications a
              where a.partner_id = pid and a.referrer_id = me and a.paid_at between p_start and p_end),
           true
    from public.users u where u.id = me;
    return;
  end if;

  return query
  with agg as (
    select a.referrer_id as rid,
           count(*) filter (where a.sent_at between p_start and p_end) as refs,
           coalesce(sum(a.monthly_rent) filter (where a.paid_at between p_start and p_end), 0) as fees
    from public.applications a
    where a.partner_id = pid and a.referrer_id is not null
    group by a.referrer_id
  ),
  peers as (
    select u.full_name as name, agg.refs::int as refs,
           case when v_mode = 'rankings' then 0::numeric else agg.fees end as fees,
           (agg.rid = me) as is_self, agg.rid as rid
    from agg join public.users u on u.id = agg.rid
    where u.role <> 'superadmin' and agg.refs > 0
  ),
  self_row as (
    select coalesce(u.full_name, 'You') as name,
           (select count(*)::int from public.applications a
              where a.partner_id = pid and a.referrer_id = me and a.sent_at between p_start and p_end) as refs,
           case when v_mode = 'rankings' then 0::numeric
                else (select coalesce(sum(a.monthly_rent), 0) from public.applications a
                        where a.partner_id = pid and a.referrer_id = me and a.paid_at between p_start and p_end) end as fees,
           true as is_self, me as rid
    from public.users u where u.id = me
  )
  select x.name, x.refs, x.fees, x.is_self
  from (
    select name, refs, fees, is_self, rid from peers where rid <> me
    union all
    select name, refs, fees, is_self, rid from self_row
  ) x
  order by x.refs desc, x.name asc;
end $function$;

revoke execute on function public.referrer_league(timestamptz, timestamptz) from public, anon;
grant execute on function public.referrer_league(timestamptz, timestamptz) to authenticated;
