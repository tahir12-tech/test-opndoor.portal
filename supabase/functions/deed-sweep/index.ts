// =====================================================================
// deed-sweep (verify_jwt = false)
//
// THE AUTOMATIC PASS THAT DID NOT EXIST. 20261005260000 ruled that a failed deed
// is retried and that "the next automatic pass" picks it up. Nothing did: of the
// eight cron-invoked functions, none called generateDeed, so the only automatic
// generation in the system was inside stripe-webhook at the moment of payment.
// Past Stripe's own redelivery window a paid application with no deed stayed that
// way until a person opened it and pressed Generate. On dev eleven paid
// applications carry no document, two of them with deed_attempts 0, meaning
// generation was never attempted rather than having failed.
//
// WHICH applications is public.deeds_awaiting_generation, deliberately in SQL.
// This function only does the calling, and it calls the SAME sequence
// stripe-webhook does (claim, generate, release on failure) so there is one
// generation path in the product and not a second one that drifts.
//
// AND SINCE 2026-10-15 IT SWEEPS THE OTHER END TOO.
//
// GR-20611 and GR-20612 were signed in PandaDoc on the evening of 14 October
// and live never recorded either: the callbacks were lost in flight, PandaDoc
// considered the matter closed, and nothing in the product was watching for
// their absence. This sweep ran every hour throughout and could not have
// helped, because deeds_awaiting_generation asks for applications with NO
// document and those two had one. The sweep answered "who was never sent a
// deed" and nobody ever answered "who signed one we never heard about".
//
// So there is a second arm. For each application still holding a document we
// believe is unsigned (public.deeds_awaiting_completion), it asks PandaDoc what
// the document's status actually is, and where PandaDoc says completed it runs
// the webhook's own completion sequence from _shared/deedCompletion.ts. Same
// code, same end state, same delivery; pandadoc_events is the lock that stops
// the two paths both acting on one signature. A reconciled completion always
// raises an ops incident, because it being repaired does not make a lost
// callback less worth knowing about.
//
// A MANUAL RUN LOOKS BEFORE IT ACTS. Reconciling issues a legal document and
// emails an agency and a tenant, so a manual run reports what it WOULD
// reconcile and does nothing unless it also passes { reconcile: true }. The
// cron always acts, which is the point of it.
//
// Auth: the cron path presents x-reminders-secret == REMINDERS_CRON_SECRET (or the
// ops_secrets mirror, as payment-reminders does). A manual run presents a
// signed-in opndoor-admin JWT and body { test: true }.
//
// TARGETED RUNS. A manual run may pass { refs: ["GR-1234", ...] } to sweep exactly
// those. That exists because the cost of this function is not CPU: every success
// creates a real PandaDoc document and sends a real email, and on a non-production
// environment those all land in one review inbox. Sweeping a backlog of eleven to
// prove that two work is not a rehearsal, it is a mess someone has to clear.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { generateDeed, documentStatus } from "../_shared/pandadoc.ts";
import { completeSignedDeed, completionEventId, COMPLETION_APP_COLUMNS } from "../_shared/deedCompletion.ts";
import { completionLockVerdict } from "../_shared/completionLock.ts";
import { deliverSigningInvite } from "../_shared/signingInvite.ts";
import { timingSafeEqual } from "../_shared/partnerAuth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-reminders-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

interface Candidate { application_id: string; guarantee_ref: string; paid_at: string; deed_attempts: number }
interface OpenDeed { application_id: string; guarantee_ref: string; pandadoc_document_id: string; livemode: boolean; deed_state: string | null }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const CRON_SECRET = Deno.env.get("REMINDERS_CRON_SECRET") ?? "";

    const body = await req.json().catch(() => ({}));
    const test = !!body.test;
    const service = createClient(SUPABASE_URL, SERVICE);

    // Same two doors as payment-reminders, including the ops_secrets mirror, which
    // is what keeps the cron working when the edge env has drifted.
    const presented = req.headers.get("x-reminders-secret") ?? "";
    // Constant time: a cron secret is a bearer credential, and `===` leaks a
    // matching prefix through timing the way a password compare does. The
    // helper already existed for the partner API and the webhook verifier.
    let cronAuthed = Boolean(presented) && Boolean(CRON_SECRET) && timingSafeEqual(presented, CRON_SECRET);
    if (!cronAuthed && presented) {
      const { data: sec } = await service.from("ops_secrets").select("secret").eq("name", "reminders_cron").maybeSingle();
      if (sec?.secret && timingSafeEqual(presented, sec.secret)) cronAuthed = true;
    }
    let adminAuthed = false;
    if (!cronAuthed) {
      const authHeader = req.headers.get("Authorization") ?? "";
      if (authHeader) {
        const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
        const { data: u } = await userClient.auth.getUser();
        if (u.user?.id) {
          const { data: prof } = await userClient.from("users").select("role").eq("id", u.user.id).maybeSingle();
          adminAuthed = prof?.role === "superadmin";
        }
      }
    }
    if (!cronAuthed && !adminAuthed) return json({ ok: false, error: "Not authorised." }, 401);
    if (!cronAuthed && !test) return json({ ok: false, error: "Manual runs must set { test: true }." }, 400);

    const olderThanMin = Number.isFinite(Number(body.olderThanMinutes)) ? Number(body.olderThanMinutes) : 30;
    const limit = Number.isFinite(Number(body.limit)) ? Math.max(0, Math.min(Number(body.limit), 100)) : 25;
    const refs: string[] = Array.isArray(body.refs) ? body.refs.map((r: unknown) => String(r)) : [];

    /* THE COMPLETION ARM'S OWN WINDOW, shorter than generation's. PandaDoc
       fires document.completed within seconds of the signature, so ten minutes
       is already long past the point where the webhook should have dealt with
       it, and waiting thirty would mean a lost callback costs the agency half an
       hour it does not need to lose. */
    const completionOlderThanMin = Number.isFinite(Number(body.completionOlderThanMinutes))
      ? Number(body.completionOlderThanMinutes) : 10;
    /* { dryRun: true } MEANS BOTH ARMS, and it is written down here because the
       first version of it did not and the mistake was instructive. It gated the
       completion arm only, so a run made to ask "what is stuck?" asked that
       question safely and then did the generation arm's full job on the way
       past: eleven PandaDoc documents created on dev and eleven signing invites
       sent, all of them to EMAIL_REVIEW_ADDRESS. A flag called dryRun that acts
       is worse than no flag, because the person using it has stopped watching.

       So: nothing is created, nothing is sent and nothing is written in a dry
       run. Both arms report what they WOULD have done. Status reads still
       happen, because they are reads and because the answer is the point of
       asking. */
    const dryRun = !!body.dryRun;
    /* Reconciling issues a Deed of Guarantee and emails an agency and a tenant.
       The cron does that by design. A person running this by hand gets a dry
       run unless they say otherwise, so "what is stuck?" is a safe question to
       ask of production. */
    const reconcile = dryRun ? false : (cronAuthed ? true : !!body.reconcile);

    const { data, error } = await service.rpc("deeds_awaiting_generation", {
      p_older_than: `${olderThanMin} minutes`,
      // A targeted run still goes through the same selection rule and then filters,
      // rather than reaching past it: naming a ref must not generate a deed for an
      // application the rule would have refused (refunded, voided, already parked).
      p_limit: refs.length ? 100 : limit,
    });
    if (error) {
      await service.rpc("report_ops_incident", {
        p_type: "deed_sweep_failed",
        p_detail: `deed-sweep could not read the candidate list: ${error.message}`,
      }).then(() => {}, () => {});
      return json({ ok: false, error: error.message }, 500);
    }

    let due = (data ?? []) as Candidate[];
    const askedFor = refs.length;
    if (refs.length) due = due.filter((c) => refs.includes(c.guarantee_ref));

    const generated: string[] = [];
    const wouldGenerate: string[] = [];
    const failed: { ref: string; error: string }[] = [];
    const skipped: { ref: string; why: string }[] = [];

    for (const c of due) {
      // Before the claim, so a dry run does not even take the lease: a claim it
      // then released would make this visible to anything watching the row.
      if (dryRun) { wouldGenerate.push(c.guarantee_ref); continue; }
      // THE SAME GATE stripe-webhook uses. Two of these running at once (the cron
      // and a person pressing Generate) must not both produce a document, and the
      // claim plus the lease inside generateDeed are what settle that.
      const claim = await service.rpc("claim_tenancy_deed", { p_application: c.application_id });
      if (claim.error) {
        failed.push({ ref: c.guarantee_ref, error: `claim failed: ${claim.error.message}` });
        continue;
      }
      if (claim.data !== true) {
        // Not a fault: something legitimate changed between the select and here.
        skipped.push({ ref: c.guarantee_ref, why: "already claimed or no longer eligible" });
        continue;
      }
      const gen = await generateDeed(service, c.application_id);
      if (!gen.ok) {
        // Release, so the next pass can try again. generateDeed has already
        // recorded the failure and raised its own incident where one is warranted.
        await service.rpc("release_tenancy_deed_claim", { p_application: c.application_id })
          .then(() => {}, () => {});
        failed.push({ ref: c.guarantee_ref, error: gen.error ?? "unknown" });
        continue;
      }
      /* AND TELL THE TENANT, which nobody did. This sweep exists for a deed
         that failed to generate at payment time: the tenant has their
         receipt, and its button worked only once the deed existed. Before
         `silent: true` PandaDoc emailed them when it finally did; now
         nothing would, and a tenant who pressed the button early and was
         told "not ready yet" would never hear again. */
      await deliverSigningInvite(service, c.application_id, { by: "System" })
        .then(() => {}, () => {/* a failed email must not fail the sweep */});
      generated.push(c.guarantee_ref);
    }

    /* ============================================================
       THE COMPLETION ARM: a deed signed in PandaDoc that we never recorded.
       ============================================================ */
    const reconciled: string[] = [];
    const wouldReconcile: string[] = [];
    const stillOut: { ref: string; status: string }[] = [];
    const unreadable: { ref: string; error: string }[] = [];
    const completionFailed: { ref: string; error: string }[] = [];
    const blockedByFreshLock: string[] = [];

    const { data: openData, error: openErr } = await service.rpc("deeds_awaiting_completion", {
      p_older_than: `${completionOlderThanMin} minutes`,
      p_limit: refs.length ? 100 : limit,
    });
    if (openErr) {
      await service.rpc("report_ops_incident", {
        p_type: "deed_sweep_failed",
        p_detail: `deed-sweep could not read the open-deed list: ${openErr.message}`,
      }).then(() => {}, () => {});
    }
    let open = (openData ?? []) as OpenDeed[];
    if (refs.length) open = open.filter((c) => refs.includes(c.guarantee_ref));

    for (const d of open) {
      /* STAMPED BEFORE THE QUESTION IS ASKED, not after it is answered. The
         candidate list is ordered by this column so the sweep round-robins,
         and a document whose status read fails every time -- a deleted
         document, a 429, a template PandaDoc will not serve -- must go to the
         back of the queue rather than occupy a slot in every run for ever and
         starve a deed that was signed this morning. */
      if (!dryRun) {
        await service.from("applications")
          .update({ deed_status_checked_at: new Date().toISOString() })
          .eq("id", d.application_id).then(() => {}, () => {});
      }

      const st = await documentStatus(d.pandadoc_document_id, d.livemode === true);
      if (!st.ok) {
        // Not an answer, so nothing is concluded and the row is left exactly as
        // it was found. See documentStatus: a 401 from a rotated key must never
        // read as "not signed yet".
        unreadable.push({ ref: d.guarantee_ref, error: st.error });
        continue;
      }
      if (st.status !== "document.completed") {
        stillOut.push({ ref: d.guarantee_ref, status: st.status });
        continue;
      }
      /* THE LOCK BETWEEN THE TWO PATHS, and the reason this is safe to run
         alongside a working webhook. Both insert the same id before doing any
         of the work, so if the callback is arriving at this moment one of the
         two is refused by the primary key and does nothing. Without this, a
         redelivery landing mid-sweep would deliver the deed twice.

         BUT A DUPLICATE KEY IS NOT "DONE", and reading it that way is what
         would have made GR-20611 and GR-20612 unrecoverable for ever. Their
         completions arrived, the dedup rows committed, `downloadPdf` returned
         null, `pdf.ok` threw before the branch that releases the row, and
         PandaDoc's retry was deduped into a 200. Two committed claims with no
         work behind them. Whether the work finished is already settled by the
         candidate query, so the only open question is the row's AGE, which
         _shared/completionLock.ts answers and vitest tests properly. */
      const evId = completionEventId(d.pandadoc_document_id);
      const heldAt = async () => {
        const { data } = await service.from("pandadoc_events")
          .select("received_at").eq("id", evId).maybeSingle();
        return (data?.received_at as string | undefined) ?? null;
      };

      /* DECIDED THE SAME WAY IN BOTH MODES. The dry run used to answer before
         the lock was ever consulted, so it reported GR-20611 and GR-20612 under
         wouldReconcile while a real run would have skipped them: a safety check
         that promises work it will not do is worse than none, because the person
         reading it has stopped watching. */
      if (!reconcile) {
        const seen = await heldAt();
        if (seen !== null && completionLockVerdict(seen, new Date().toISOString()) === "wait") {
          blockedByFreshLock.push(d.guarantee_ref);
        } else {
          wouldReconcile.push(d.guarantee_ref);
        }
        continue;
      }

      let adoptedTombstone = false;
      const { error: lockErr } = await service.from("pandadoc_events")
        .insert({ id: evId, type: "document.completed" });
      if (lockErr) {
        if (lockErr.code !== "23505") {
          unreadable.push({ ref: d.guarantee_ref, error: `could not take the completion lock: ${lockErr.message}` });
          continue;
        }
        const seen = await heldAt();
        if (completionLockVerdict(seen, new Date().toISOString()) === "wait") {
          // Young enough to have a live request behind it. Back off; the sweep
          // will be here again in an hour.
          blockedByFreshLock.push(d.guarantee_ref);
          continue;
        }
        adoptedTombstone = true;
      }

      const { data: app, error: appErr } = await service.from("applications")
        .select(COMPLETION_APP_COLUMNS).eq("id", d.application_id).maybeSingle();
      if (appErr || !app) {
        // Drop the lock, or the webhook could never re-present this either.
        await service.from("pandadoc_events").delete().eq("id", evId).then(() => {}, () => {});
        unreadable.push({ ref: d.guarantee_ref, error: `could not re-read the application: ${appErr?.message ?? "no row"}` });
        continue;
      }

      const done = await completeSignedDeed(service, app, d.pandadoc_document_id, d.livemode === true);
      if (!done.ok) {
        /* ITS OWN LIST, not the generation arm's. `failed` feeds the
           deed_sweep_all_failed alert, whose message says the sweep generated
           nothing, and a completion failure landing there would make that
           alert say something untrue about a different arm. */
        completionFailed.push({ ref: d.guarantee_ref, error: done.error });
        continue;
      }
      reconciled.push(d.guarantee_ref);

      /* A REPAIRED LOSS IS STILL A LOSS. The deed is now issued and delivered,
         so nothing is broken for the agency any more -- which is exactly why
         this has to be said out loud. A webhook that silently stops working
         would otherwise look like a healthy system with a slightly slow sweep,
         and the next thing to go wrong would be the one nobody is told about.
         Deduped hourly by type, like every other incident. */
      await service.rpc("report_ops_incident", {
        p_type: "deed_completion_reconciled",
        p_detail: `${d.guarantee_ref} (${d.application_id}) was completed in PandaDoc but never recorded: document ${d.pandadoc_document_id} read as completed and the deed has now been executed and delivered by the sweep. ${adoptedTombstone
          ? "A pandadoc_events row for this completion ALREADY EXISTED, so the callback did arrive and the handler died part-way through without releasing its claim. That is a fault in the webhook, not a lost request: check the pandadoc-webhook logs for a thrown error at the signature time, and note that a handler which dies between taking the dedup row and finishing its work loses the event permanently."
          : "There was no pandadoc_events row for it, so the callback did not arrive at all. Check PandaDoc's webhook delivery history for this document and confirm PANDADOC_WEBHOOK_SHARED_KEY still matches the subscription."}`,
      }).then(() => {}, () => {});
    }

    /* ONE ALERT FOR THE RUN, not one per application. A sweep that fails for
       everything it touched is almost always one cause (an unset PANDADOC_API_KEY,
       the template id, the database refusing), and the per-application incidents
       generateDeed raises are deduped hourly by type. This says the sweep itself
       is not working, which is the thing nobody would otherwise notice: a cron
       whose every attempt fails looks exactly like a cron with nothing to do. */
    if (failed.length && !generated.length) {
      await service.rpc("report_ops_incident", {
        p_type: "deed_sweep_all_failed",
        p_detail: `deed-sweep tried ${failed.length} application(s) and generated none. First error: ${failed[0].error}`,
      }).then(() => {}, () => {});
    }

    return json({
      ok: true,
      mode: cronAuthed ? "cron" : "manual",
      olderThanMinutes: olderThanMin,
      ...(askedFor ? { askedFor: refs, matched: due.length } : {}),
      dryRun,
      candidates: due.length,
      generated,
      ...(dryRun ? { wouldGenerate } : {}),
      failed,
      skipped,
      // The completion arm. `reconcile: false` is a dry run, and then
      // wouldReconcile names what a real run would act on.
      completion: {
        reconcile,
        olderThanMinutes: completionOlderThanMin,
        open: open.length,
        reconciled,
        ...(reconcile ? {} : { wouldReconcile }),
        // Held by a claim too young to step on. Named rather than silently
        // folded into stillOut, because "a webhook is mid-flight" and "PandaDoc
        // says it is not signed" are different answers.
        blockedByFreshLock,
        stillOut,
        unreadable,
        failed: completionFailed,
      },
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
