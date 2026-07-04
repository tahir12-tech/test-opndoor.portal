-- #79 Referrer leaderboard visibility: a per-partner setting with three levels,
-- editable by that partner's Management and by opndoor admin. Default 'full'.
--   full     -> referrers see partner-peers ranked with fees collected + counts
--   rankings -> referrers see peers ranked with counts only (no money)
--   private  -> referrers see only their own performance
-- Commission (partner/agent) is NEVER exposed to a referrer at any level.
alter table public.partners
  add column if not exists referrer_leaderboard_mode text not null default 'full'
  check (referrer_leaderboard_mode in ('full','rankings','private'));

-- Governed writer: opndoor admin, or that partner's own Management. Mirrors
-- update_partner_settings (AAL2 gate, one partner_audit row per change).
create or replace function public.set_referrer_leaderboard_mode(p_slug text, p_mode text)
returns public.partners
language plpgsql security definer set search_path to ''
as $function$
declare cur public.partners; res public.partners; who text;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if p_mode not in ('full','rankings','private') then raise exception 'Invalid leaderboard mode' using errcode = '22023'; end if;
  select * into cur from public.partners where slug = p_slug;
  if cur.id is null then raise exception 'Partner not found' using errcode = '22023'; end if;
  if not (public.is_admin() or (public.app_role() = 'management' and cur.id = public.app_partner())) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  who := coalesce((select full_name from public.users where id = auth.uid()), 'an administrator');
  if cur.referrer_leaderboard_mode is distinct from p_mode then
    insert into public.partner_audit(partner_id, field, old_value, new_value, actor)
    values (cur.id, 'referrer_leaderboard', cur.referrer_leaderboard_mode, p_mode, who);
  end if;
  update public.partners set referrer_leaderboard_mode = p_mode where id = cur.id returning * into res;
  return res;
end $function$;

revoke execute on function public.set_referrer_leaderboard_mode(text, text) from public, anon;
grant execute on function public.set_referrer_leaderboard_mode(text, text) to authenticated;

-- Reader for the referrer board. RLS restricts a referrer to their OWN
-- applications, so a partner-wide peer ranking is impossible client-side; this
-- SECURITY DEFINER function returns the ranking, enforcing the mode server-side.
-- It NEVER selects commission. In 'rankings' fees are zeroed; in 'private' only
-- the caller's own row is returned. Superadmin referrers are excluded (mirrors
-- the client keyOf rule).
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
  )
  select u.full_name,
         agg.refs::int,
         case when v_mode = 'rankings' then 0::numeric else agg.fees end,
         (agg.rid = me)
  from agg
  join public.users u on u.id = agg.rid
  where u.role <> 'superadmin' and agg.refs > 0
  order by agg.refs desc, u.full_name asc;
end $function$;

revoke execute on function public.referrer_league(timestamptz, timestamptz) from public, anon;
grant execute on function public.referrer_league(timestamptz, timestamptz) to authenticated;
