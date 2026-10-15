-- =====================================================================
-- A SIGNED DEED IS FOUND EVEN WITHOUT ITS CALLBACK.
--
-- GR-20611 and GR-20612 were completed in PandaDoc on the evening of
-- 14 October 2026 and live never recorded either. pandadoc_events holds a
-- document.viewed for 20612 and no completion, both rows still read
-- deed_state 'awaiting_tenant' with deed_attempts 0 and no error, and
-- completions have arrived normally since. So the callbacks were lost in
-- flight, once, and nothing in the product was watching for their absence.
--
-- The hourly deed-sweep could not help, and that is the part worth fixing.
-- deeds_awaiting_generation asks for applications with NO document and
-- deed_state null or 'error'; these two have a document and are
-- 'awaiting_tenant', so they are excluded twice over. The sweep is a
-- GENERATION sweep: it answers "who was never sent a deed", and nobody ever
-- answered "who signed one we never heard about".
--
-- THIS IS THAT QUESTION. Same shape as deeds_awaiting_generation, and
-- deliberately in SQL for the same reason: the selection rule is the part that
-- has to be reviewable and testable without a PandaDoc account. The edge
-- function does the asking and the recording.
-- =====================================================================

/* WHEN WE LAST ASKED PANDADOC ABOUT THIS DOCUMENT.
   Additive, nullable, no default: every existing row reads null, which the
   ordering below treats as "never asked" and therefore first.

   It exists to make the per-run bound honest. Without it the candidate list
   would be ordered by age and a run of 25 would check the 25 oldest open
   deeds every hour for ever -- so once more than 25 deeds are out for
   signature, a deed signed this morning would sit behind a queue of deeds
   nobody is ever going to sign. Stamping each check and ordering by the stamp
   makes the sweep round-robin: every open deed is reached, and a document
   whose status read keeps failing goes to the back rather than blocking the
   queue, because the sweep stamps whether the read worked or not. */
alter table public.applications
  add column if not exists deed_status_checked_at timestamptz;

comment on column public.applications.deed_status_checked_at is
  'When deed-sweep last asked PandaDoc for this document''s status. Null means never. Ordering the completion sweep by this is what stops a backlog of unsigned deeds starving a freshly signed one.';

create or replace function public.deeds_awaiting_completion(
  p_older_than interval default interval '10 minutes',
  p_limit int default 25
)
returns table (
  application_id uuid,
  guarantee_ref text,
  pandadoc_document_id text,
  livemode boolean,
  deed_state text,
  deed_sent_at timestamptz,
  deed_status_checked_at timestamptz
)
language sql stable security definer set search_path to ''
as $function$
  select a.id, a.guarantee_ref, a.pandadoc_document_id, a.livemode, a.deed_state,
         a.deed_sent_at, a.deed_status_checked_at
    from public.applications a
   -- There is a document, so there is something to ask PandaDoc about. This is
   -- the exact inverse of deeds_awaiting_generation's first condition, and
   -- between them the two functions cover every paid application.
   where a.pandadoc_document_id is not null
     -- STILL BELIEVED TO BE OUT FOR SIGNATURE. 'executed' is done. 'voided' and
     -- 'declined' are outcomes already recorded, and a tenant cannot sign
     -- either. A NULL deed_state is deliberately INCLUDED: a row with a
     -- document id and no state is the deed_stamp_partial case in
     -- _shared/pandadoc.ts, where the id was secured but the surrounding
     -- columns were not, and that row is signable and would otherwise be the
     -- one nobody could ever reconcile.
     and coalesce(a.deed_state, '') not in ('executed', 'voided', 'declined')
     -- apply_deed_executed moves status from 'paid' to 'deed' in the same
     -- statement that sets deed_state, so a row still reading 'paid' is one
     -- whose signature we have not recorded.
     and a.status = 'paid'
     -- The money went back, so the guarantee it paid for must not be issued.
     -- apply_deed_executed refuses these anyway and raises its own alert; this
     -- keeps the sweep from spending a PandaDoc call to be refused.
     and coalesce(a.payment_state, '') <> 'refunded'
     and a.withdrawn_at is null
     -- THE RECONCILIATION WINDOW. PandaDoc fires document.completed within
     -- seconds of the signature, so anything this recent is probably mid-flight
     -- in pandadoc-webhook and asking about it would be the second presser in a
     -- double-click. The pandadoc_events primary key settles that race anyway;
     -- this keeps us from routinely relying on it.
     and coalesce(a.deed_sent_at, a.paid_at) is not null
     and coalesce(a.deed_sent_at, a.paid_at) < now() - p_older_than
   -- Never-asked first, then longest-since-asked. See the column comment.
   order by a.deed_status_checked_at asc nulls first,
            coalesce(a.deed_sent_at, a.paid_at) asc
   limit greatest(p_limit, 0)
$function$;

comment on function public.deeds_awaiting_completion(interval, int) is
  'Applications holding a PandaDoc document we still believe is unsigned. deed-sweep asks PandaDoc for each one''s real status and reconciles a completion whose callback was lost. The generation twin is deeds_awaiting_generation.';

/* SERVICE ROLE ONLY, like deeds_awaiting_generation. This is a cron's view of
   the whole estate: it crosses every partner and every rail and makes no reach
   check, so nothing a browser holds may call it. It is therefore not on the
   definer allowlist, which is the list of definers granted to authenticated. */
revoke all on function public.deeds_awaiting_completion(interval, int) from public, anon, authenticated;
grant execute on function public.deeds_awaiting_completion(interval, int) to service_role;
