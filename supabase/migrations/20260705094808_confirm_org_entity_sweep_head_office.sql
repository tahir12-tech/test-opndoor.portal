-- #96 (owner ruling): confirming an agency in Reconciliation auto-confirms its
-- pending auto-created "[Agency], Head office" branch in the same action (a single-
-- office auto-branch has no independent facts to review). Independently created
-- branches (any other name) still queue and confirm separately.
create or replace function public.confirm_org_entity(p_type text, p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare me uuid := auth.uid(); who text; nm text; ho_id uuid; ho_name text;
begin
  if not public.is_aal2() then raise exception 'MFA required' using errcode = '42501'; end if;
  if not public.is_admin() then raise exception 'not permitted' using errcode = '42501'; end if;
  who := coalesce((select full_name from public.users where id = me), 'an administrator');
  if p_type = 'agency' then
    update public.agencies set review_state = 'confirmed'
      where id = p_id and review_state = 'pending_review' returning name into nm;
    if nm is null then raise exception 'Entity not found or already confirmed' using errcode = '22023'; end if;
    insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
    values ('agency', p_id, 'confirmed', nm, who, me);
    -- Sweep the self-identifying auto-created head office branch (only that exact
    -- name, still pending); other branches keep their own review.
    update public.branches set review_state = 'confirmed'
      where agency_id = p_id and review_state = 'pending_review'
        and lower(name) = lower(nm || ', Head office')
      returning id, name into ho_id, ho_name;
    if ho_id is not null then
      insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
      values ('branch', ho_id, 'confirmed', ho_name || ' (auto-confirmed with agency)', who, me);
    end if;
    return;
  elsif p_type = 'branch' then
    update public.branches set review_state = 'confirmed'
      where id = p_id and review_state = 'pending_review' returning name into nm;
    if nm is null then raise exception 'Entity not found or already confirmed' using errcode = '22023'; end if;
    insert into public.org_audit(entity_type, entity_id, action, detail, actor, actor_id)
    values ('branch', p_id, 'confirmed', nm, who, me);
    return;
  else
    raise exception 'Unknown entity type' using errcode = '22023';
  end if;
end $function$;

revoke execute on function public.confirm_org_entity(text, uuid) from public, anon;
grant execute on function public.confirm_org_entity(text, uuid) to authenticated;
