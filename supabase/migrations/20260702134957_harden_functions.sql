-- Pin search_path on the remaining functions (advisor 0011).
alter function public.guarantee_expiry(date)                        set search_path = '';
alter function public.can_amend_tenancy_start(text, text, boolean)  set search_path = '';
alter function public.can_send_deed(text, boolean)                  set search_path = '';
alter function public.sync_branch_partner()                         set search_path = '';
alter function public.sync_contact_partner()                        set search_path = '';
alter function public.sync_application_partner()                    set search_path = '';
alter function public.contacts_maintain_primary()                  set search_path = '';
alter function public.contacts_promote_on_delete()                 set search_path = '';

-- Contact resolvers should respect the caller's RLS on a direct call, while
-- still resolving fully when invoked inside send_deed_to_agent (which runs as
-- the table owner and bypasses RLS). SECURITY INVOKER gives us exactly that.
alter function public.effective_contacts(uuid)         security invoker;
alter function public.effective_primary_contact(uuid)  security invoker;

-- Close the anon-callable SECURITY DEFINER surface (advisor 0028): remove the
-- blanket PUBLIC execute, then grant only where it is actually needed.
revoke execute on all functions in schema public from public;

grant execute on function
  public.app_role(),
  public.app_partner(),
  public.is_admin(),
  public.is_aal2(),
  public.guarantee_expiry(date),
  public.can_amend_tenancy_start(text, text, boolean),
  public.can_send_deed(text, boolean),
  public.effective_contacts(uuid),
  public.effective_primary_contact(uuid),
  public.create_referral(uuid, text, text, text, date, text, text, text, text, text, text, text, numeric, date),
  public.amend_tenancy_start(uuid, date),
  public.send_deed_to_agent(uuid, text, boolean),
  public.set_application_status(uuid, text)
to authenticated, service_role;
