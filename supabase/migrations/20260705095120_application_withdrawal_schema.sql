-- #2 WITHDRAWN terminal state for applications at Sent (pre-payment only). Markable
-- by the referring user (own referrals) or management/admin, with a reason. Terminal:
-- it LEAVES the Sent cohort, so it is a status value (not a flag), plus audit columns.
alter table public.applications add column if not exists withdrawn_at timestamptz;
alter table public.applications add column if not exists withdrawn_reason text
  check (withdrawn_reason is null or withdrawn_reason in ('another_guarantor','tenancy_fell_through','duplicate','other'));
alter table public.applications add column if not exists withdrawn_note text;
alter table public.applications add column if not exists withdrawn_by uuid references public.users(id);

-- Widen the status machine: withdrawn is pre-payment only (paid_at must be null).
alter table public.applications drop constraint if exists applications_status_check;
alter table public.applications add constraint applications_status_check
  check (status = any (array['sent','paid','deed','withdrawn']));
alter table public.applications drop constraint if exists applications_status_dates;
alter table public.applications add constraint applications_status_dates
  check ((status = 'sent')
      or (status = 'withdrawn' and paid_at is null)
      or (status = 'paid' and paid_at is not null)
      or (status = 'deed' and paid_at is not null and deed_issued_at is not null));

-- mark_withdrawn: Sent-only; referrer (own) or management (partner) or admin.
create or replace function public.mark_withdrawn(p_app uuid, p_reason text, p_note text)
returns public.applications
language plpgsql security definer set search_path to ''
as $function$
declare a public.applications; r text; owned boolean; who text; lbl text;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into a from public.applications where id = p_app;
  if not found then raise exception 'application not found'; end if;
  r := public.app_role();
  owned := a.referrer_id = auth.uid();
  if not (public.is_admin() or (r = 'management' and a.partner_id = public.app_partner()) or (r = 'referrer' and owned)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if a.status <> 'sent' then raise exception 'Only an application at Sent (before payment) can be withdrawn.' using errcode = '42501'; end if;
  if p_reason not in ('another_guarantor','tenancy_fell_through','duplicate','other') then
    raise exception 'Invalid withdrawal reason' using errcode = '22023';
  end if;
  if p_reason = 'other' and coalesce(btrim(p_note), '') = '' then
    raise exception 'A note is required when the reason is Other.' using errcode = '22023';
  end if;
  update public.applications
    set status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = p_reason,
        withdrawn_note = nullif(btrim(coalesce(p_note,'')), ''), withdrawn_by = auth.uid()
    where id = p_app returning * into a;
  who := coalesce((select full_name from public.users where id = auth.uid()), 'a user');
  lbl := case p_reason
           when 'another_guarantor' then 'tenant found another guarantor'
           when 'tenancy_fell_through' then 'tenancy fell through'
           when 'duplicate' then 'duplicate referral'
           else 'other' end;
  insert into public.activity_log(application_id, kind, message, actor, visibility)
  values (p_app, 'withdrawn',
    'Application withdrawn (' || lbl || ')' || case when a.withdrawn_note is not null then ': ' || a.withdrawn_note else '' end || '.',
    who, 'business');
  return a;
end $function$;
revoke execute on function public.mark_withdrawn(uuid, text, text) from public, anon;
grant execute on function public.mark_withdrawn(uuid, text, text) to authenticated, service_role;

-- Exclude withdrawn from the referrer leaderboard refs (it left the Sent cohort).
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
              where a.partner_id = pid and a.referrer_id = me and a.status <> 'withdrawn' and a.sent_at between p_start and p_end),
           (select coalesce(sum(a.monthly_rent), 0) from public.applications a
              where a.partner_id = pid and a.referrer_id = me and a.paid_at between p_start and p_end),
           true
    from public.users u where u.id = me;
    return;
  end if;

  return query
  with agg as (
    select a.referrer_id as rid,
           count(*) filter (where a.status <> 'withdrawn' and a.sent_at between p_start and p_end) as ct,
           coalesce(sum(a.monthly_rent) filter (where a.paid_at between p_start and p_end), 0) as amt
    from public.applications a
    where a.partner_id = pid and a.referrer_id is not null
    group by a.referrer_id
  ),
  peers as (
    select u.full_name as rname, agg.ct::int as rrefs,
           case when v_mode = 'rankings' then 0::numeric else agg.amt end as rfees,
           (agg.rid = me) as rself, agg.rid as rrid
    from agg join public.users u on u.id = agg.rid
    where u.role <> 'superadmin' and agg.ct > 0
  ),
  self_row as (
    select coalesce(u.full_name, 'You') as rname,
           (select count(*)::int from public.applications a
              where a.partner_id = pid and a.referrer_id = me and a.status <> 'withdrawn' and a.sent_at between p_start and p_end) as rrefs,
           case when v_mode = 'rankings' then 0::numeric
                else (select coalesce(sum(a.monthly_rent), 0) from public.applications a
                        where a.partner_id = pid and a.referrer_id = me and a.paid_at between p_start and p_end) end as rfees,
           true as rself, me as rrid
    from public.users u where u.id = me
  )
  select x.rname, x.rrefs, x.rfees, x.rself
  from (
    select p.rname, p.rrefs, p.rfees, p.rself, p.rrid from peers p where p.rrid <> me
    union all
    select s.rname, s.rrefs, s.rfees, s.rself, s.rrid from self_row s
  ) x
  order by x.rrefs desc, x.rname asc;
end $function$;
revoke execute on function public.referrer_league(timestamptz, timestamptz) from public, anon;
grant execute on function public.referrer_league(timestamptz, timestamptz) to authenticated;

-- Guard the payment transition: a payment landing on a WITHDRAWN application is an
-- anomaly (post-payment exits are the refund flow), never a silent Sent->Paid.
create or replace function public.apply_stripe_payment(
  p_application_id uuid, p_payment_intent text, p_amount numeric, p_session_id text
) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.applications;
begin
  select * into a from public.applications where id = p_application_id;
  if not found then raise exception 'application not found'; end if;
  if a.status = 'sent' then
    update public.applications set
      status = 'paid', paid_at = coalesce(paid_at, now()),
      stripe_payment_intent_id   = coalesce(p_payment_intent, stripe_payment_intent_id),
      stripe_checkout_session_id = coalesce(p_session_id, stripe_checkout_session_id),
      paid_amount   = coalesce(p_amount, paid_amount), payment_state = 'paid'
    where id = p_application_id;
  elsif a.status = 'withdrawn' then
    -- Record the intent for traceability but do NOT flip to paid; flag for refund.
    update public.applications set
      stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
      stripe_checkout_session_id = coalesce(stripe_checkout_session_id, p_session_id)
    where id = p_application_id;
    insert into public.activity_log(application_id, kind, message, actor, visibility)
    values (p_application_id, 'payment_anomaly',
      'Guarantor fee paid on a WITHDRAWN application. Review and refund required.', 'System', 'business');
  else
    update public.applications set
      stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
      paid_amount   = coalesce(paid_amount, p_amount),
      payment_state = coalesce(payment_state, 'paid')
    where id = p_application_id;
  end if;
end $$;
