// =====================================================================
// THE ONE COMPLETION PATH.
//
// A tenant signing the deed is the end of the journey, and until now the only
// thing in the product that could notice was pandadoc-webhook. That made the
// webhook a single point of failure for the whole rail: if one callback is
// lost -- the function redeploying mid-delivery, a rotated shared key, a
// subscription edited in PandaDoc -- the document is signed, PandaDoc considers
// the matter closed, and the application sits at awaiting_tenant for ever with
// nothing watching for the absence. That is exactly what happened to GR-20611
// and GR-20612 on the evening of 14 October 2026: completed in PandaDoc, never
// recorded, and the hourly deed-sweep could not help because it is a
// GENERATION sweep and both rows already had a document.
//
// So deed-sweep now also reconciles completions, and this module is what both
// callers run. It is NOT a second implementation: it is the webhook's own
// completion sequence, moved here unchanged, so there is one path and not two
// that drift. Every comment inside it was written against a specific failure
// and is kept verbatim for that reason.
//
// THE TWO CALLERS DIFFER ONLY IN WHAT THEY DO WITH A RETRYABLE FAILURE.
// The webhook throws, which answers PandaDoc 500 and asks for a redelivery.
// The sweep records it and leaves the row alone, and the next hour is its
// redelivery. Both want the same thing from here: the dedup row dropped so the
// completion can be re-presented, and a plain statement that it is not done.
//
// AND THEY CANNOT COLLIDE. `pandadoc_events` is the mutual exclusion between
// them, not merely the webhook's retry guard: both paths insert the same id,
// `<document>:document.completed`, BEFORE doing any of this, so whichever
// arrives second is refused by the primary key and does nothing. That is what
// stops a swept deed being delivered twice when the lost callback turns up.
// =====================================================================
import { downloadPdf } from "./pandadoc.ts";
import { deliverDeedToAgent } from "./deedEmail.ts";
import { deliverExecutedDeedToTenant } from "./executedDeedEmail.ts";
import { maySendOpndoorEmail } from "./livemodeCredentials.ts";
import { titleCaseAddress } from "./text.ts";

/* ONE COLUMN LIST, because the completion sequence reads fifteen of them and a
   caller that selects fourteen produces a bug that only shows on the one
   branch that touches the missing one. Both callers select exactly this. */
export const COMPLETION_APP_COLUMNS =
  "id, guarantee_ref, branch_id, tenant_title, tenant_first_name, tenant_last_name, tenant_email, prop_addr1, prop_postcode, tenancy_start, livemode, deed_delivered_at, deed_delivered_to, deed_issued_at, agency:agencies(name)";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CompletionApp = any;

export type CompletionResult =
  /* `refunded` is done rather than failed: the money went back, the deed was
     refused, and retrying would refuse it again. The caller keeps the dedup
     row. */
  | { ok: true; refunded?: boolean }
  /* The dedup row has ALREADY been dropped by the time this is returned, so a
     caller only has to decide how to ask for another go. */
  | { ok: false; retryable: true; error: string };

/* The event id both paths dedup on. Exported so a caller can insert it before
   calling, which is the lock described above. */
export const completionEventId = (docId: string) => `${docId}:document.completed`;

/* `app` is non-null by construction: a completion that matches no application
   is a different problem with its own alert
   (pandadoc_completed_unknown_document), and both callers deal with it before
   they get here. The `if (app)` guards inside are from the webhook and are now
   structurally dead; they are left exactly as they were because re-indenting
   280 lines of hard-won failure handling to remove a harmless guard is a poor
   trade on a path that issues legal documents. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function completeSignedDeed(service: any, app: CompletionApp, docId: string, eventLivemode: boolean): Promise<CompletionResult> {
  const evId = completionEventId(docId);
  /* ANY FAILURE AFTER THE CLAIM IS TAKEN MUST RELEASE THE CLAIM, including one
     nobody predicted. Every arm inside already releases it deliberately, but on
     live on 14 October the sequence died on a line nobody had written a release
     for: `pdf.ok` threw on a null, and a throw is not a branch, so none of the
     careful cleanup ran. PandaDoc's retry then hit the primary key, was answered
     200, and the deed was unrecoverable until the sweep learned to adopt an
     abandoned claim.

     So the guard sits out here, around all of it. It is the difference between
     "a deed is late" and "a deed is lost". The body is a separate function
     purely so that wrapping it did not re-indent 280 lines of hard-won failure
     handling, and `state.executed` is how the catch knows which side of
     apply_deed_executed it is on. */
  const state = { executed: false };
  try {
    return await runCompletion(service, app, docId, eventLivemode, evId, state);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!state.executed) {
      /* The deed was NOT issued, so the claim is a lie and has to go. Dropping
         it lets PandaDoc's redelivery reprocess rather than be deduped into a
         200, and lets the sweep take it if PandaDoc has given up. */
      await service.from("pandadoc_events").delete().eq("id", evId).then(() => {}, () => {});
      return { ok: false, retryable: true, error: `Completion of ${docId} failed before the deed was issued: ${msg}` };
    }
    /* THE DEED IS ISSUED, SO THE CLAIM STAYS. Past this point a re-run would
       deliver a second copy of a deed somebody already has, which is the one
       thing the dedup row exists to prevent. What failed is delivery or
       bookkeeping, so it is reported rather than retried, and the application
       reads 'executed' so the sweep will not pick it up either. */
    await service.rpc("report_ops_incident", {
      p_type: "deed_post_execution_failed",
      p_detail: `Application ${app?.id} (${app?.guarantee_ref}): PandaDoc document ${docId} was executed and the deed IS issued, but the work after execution failed (${msg}). The signed deed may not have been delivered. Check the application's feed and use Send deed to agent if there is no delivery.`,
    }).then(() => {}, () => {});
    return { ok: true };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runCompletion(service: any, app: CompletionApp, docId: string, eventLivemode: boolean, evId: string, state: { executed: boolean }): Promise<CompletionResult> {
  /* THE EXECUTED DEED IS SECURED BEFORE ANYTHING IS DECLARED DONE.

     This used to download the PDF, ignore whether it worked, and carry on
     to execute the deed with p_pdf_path null. The dedup row was already
     committed, so the completion could never be re-presented: the deed was
     executed and the signed document was gone for good. Four surfaces then
     have nothing to show, with no repair path between them:
     send-deed-to-agent and send-deed-to-landlord mail a link to nothing,
     tenant-portal answers "not ready to download yet" for ever, and
     referencing-callback counts the application as failed.

     A failed download is nearly always transient, and the commonest case
     is a race we caused by being fast: PandaDoc renders the signed PDF
     after it fires document.completed, so an immediate fetch can 404 for a
     few seconds. So it is retried rather than absorbed: drop the dedup row,
     raise the incident, throw, and let PandaDoc redeliver.

     THE TRADE, stated plainly because it is a real one. If PandaDoc never
     serves the PDF and exhausts its redeliveries, the deed stays
     un-executed instead of executing without its document. That is the
     better failure: it is visible (the application sits at awaiting_tenant
     with a signed document behind it), it is alerted hourly, and it is
     recoverable by hand. The old behaviour was invisible and permanent.
     HANDOVER-BALAL.md section 10 carries the runbook entry. */
  let path: string | null = null;
  if (app) {
    const pdf = await downloadPdf(docId, eventLivemode);
    /* `!pdf` FIRST, AND IT IS NOT DEFENSIVE PADDING. On live, 14 October 2026,
       this line read `!pdf.ok` and the helper behind it returned null: the
       TypeError fired here, BEFORE the branch below that releases the dedup
       row, so GR-20611's completion became a committed claim with no work
       behind it and PandaDoc's retry was deduped into a 200. Our own
       downloadPdf cannot return null, but live's pandadoc-webhook bundle was
       redeployed separately and carries a different one. A permanent loss must
       not be one `undefined` away. */
    if (!pdf || !pdf.ok || !pdf.bytes) {
      await service.rpc("report_ops_incident", {
        p_type: "deed_pdf_unavailable",
        p_detail: `Application ${app.id} (${app.guarantee_ref}): the tenant signed deed ${docId} but the executed PDF could not be downloaded from PandaDoc (${pdf?.error ?? "the download helper returned no result"}). The deed has NOT been executed and PandaDoc will redeliver. If this repeats for more than an hour, the PDF is not being rendered and the deed must be executed by hand.`,
      }).then(() => {}, () => {});
      await service.from("pandadoc_events").delete().eq("id", evId).then(() => {}, () => {});
      return { ok: false, retryable: true, error: `Executed PDF for ${docId} could not be downloaded: ${pdf?.error ?? "the download helper returned no result"}` };
    }
    path = `${app.id}/${app.guarantee_ref}.pdf`;
    // The upload error was discarded too, which produced the same end state
    // by a different route: a path written onto the row pointing at an
    // object that was never stored.
    const { error: upErr } = await service.storage.from("deeds")
      .upload(path, pdf.bytes, { contentType: "application/pdf", upsert: true });
    if (upErr) {
      await service.rpc("report_ops_incident", {
        p_type: "deed_pdf_not_stored",
        p_detail: `Application ${app.id} (${app.guarantee_ref}): the executed deed ${docId} was downloaded from PandaDoc but could not be stored (${upErr.message}). The deed has NOT been executed and PandaDoc will redeliver.`,
      }).then(() => {}, () => {});
      await service.from("pandadoc_events").delete().eq("id", evId).then(() => {}, () => {});
      return { ok: false, retryable: true, error: `Executed PDF for ${docId} could not be stored: ${upErr.message}` };
    }
  }
  // supabase-js returns a DB error object rather than throwing: check it, or a
  // transient failure would leave the deed un-executed while the "signed and
  // issued" emails below still send. Delete the dedup row (so a PandaDoc retry
  // re-processes rather than being deduped) and throw -> 500 -> retry.
  const { data: execOutcome, error: execErr } = await service.rpc("apply_deed_executed", { p_document_id: docId, p_pdf_path: path });
  if (execErr) {
    await service.from("pandadoc_events").delete().eq("id", evId).then(() => {}, () => {});
    return { ok: false, retryable: true, error: `apply_deed_executed failed: ${execErr.message}` };
  }
  /* AND IT CAN REFUSE WITHOUT ERRORING. The RPC returned void until
     20261005270000, so a refusal was indistinguishable from a success and
     this handler carried straight on: it wrote the "signed and issued"
     trail, sent the agent and tenant emails, and answered PandaDoc 200. The
     dedup row written before the call then makes a redelivery a no-op, so
     the refusal could never be re-presented.

     'refunded' is the one that must not be treated as done: the money went
     back and the deed must not be issued, but the document is signed and
     live in PandaDoc and somebody has to void it. It is not retryable, so
     we keep the dedup row and answer 200 (retrying would refuse again), and
     raise an incident that names the document to void. */
  if (execOutcome === "refunded") {
    await service.rpc("report_ops_incident", {
      p_type: "deed_executed_after_refund",
      p_detail: `PandaDoc document ${docId} completed for a REFUNDED application. The deed was refused and not issued. Void ${docId} in PandaDoc.`,
    }).then(() => {}, () => {});
    return { ok: true, refunded: true };
  }
  /* FROM HERE A RE-RUN WOULD DELIVER A SECOND DEED. apply_deed_executed has
     committed, so the catch in completeSignedDeed must KEEP the claim. */
  state.executed = true;
  if (app) {
    // The signing event. The "Deed Issued" milestone (status/timeline) is
    // driven by apply_deed_executed above; this is the distinct signed entry.
    await service.from("activity_log").insert({ application_id: app.id, kind: "deed_signed", message: "Deed signed by the tenant.", actor: "PandaDoc", visibility: "business" });
    await service.from("pandadoc_events").update({ application_id: app.id }).eq("id", evId);

    // Automatic deed delivery to the resolved claim contact (branch contact ->
    // agency default). Runs exactly once per document: the pandadoc_events
    // insert above dedups a webhook retry, so it cannot double-send. This is
    // the same email the manual "Send deed to agent" button sends; if no
    // contact resolves we record it for the needs-attention surface, never
    // failing silently. The manual button is the recovery/resend path.
    // Sandbox sends neither of the two Opndoor emails below. The agent one is
    // the sharper edge: the agent contact on a sandbox application is a real
    // letting agent's address if a developer used a real one in a test
    // payload, and it would arrive carrying an executed Deed of Guarantee for
    // a tenancy that does not exist.
    const mayEmail = maySendOpndoorEmail(app.livemode === true);
    // Where the executed deed goes, resolved in one place by deed_delivery_target:
    // the tenant-named delivery contact when there is one (the direct rail), else
    // the branch's effective primary contact (the referral rail). We send to the
    // address the tenant gave, on every rail, with no verification gate: if it
    // bounces, that surfaces as a failed delivery on the needs-attention surface,
    // which is enough. Sandbox still sends nothing.
    /* EVERY ROW, not the first. deed_delivery_target returns one row per
       recipient on the agency rail now -- the referrer and every ticked
       user whose position covers the referral -- because the deed is a
       per-application notification like the expiry reminder, and those
       already go to the whole ladder. The other two rails return one row,
       so `dest` below is unchanged for them. */
    const { data: target, error: targetErr } = await service.rpc("deed_delivery_target", { p_application: app.id });
    const targets = (Array.isArray(target) ? target : target ? [target] : [])
      .filter((t: { email?: string | null }) => (t.email ?? "").trim().length > 0);
    const dest = targets[0] ?? (Array.isArray(target) ? target[0] : target);
    const alsoTo = targets.slice(1).map((t: { email: string }) => t.email);
    /* An unread ladder is not an empty one. Discarding this error made a
       transient RPC failure indistinguishable from "this agency has
       nobody", and that branch writes "No agent contact on file" into the
       feed and parks the row. It cannot be retried from here: the deed is
       already executed and the dedup row is committed, so a 500 would be
       deduped into nothing on redelivery. It parks with an HONEST reason
       instead, which the manual Send deed to agent button clears. */
    /* CAN THIS DEED BE DELIVERED is a question about the APPLICATION.
       WHETHER WE MAY SEND EMAIL is a question about the ENVIRONMENT. They
       were tested together, and mixing them made sandbox lie: with mayEmail
       false a perfectly deliverable deed fell into the cannot-deliver
       branch, parked as awaiting_staff_send, wrote "No agent contact on
       file" into the feed and raised a deed_awaiting_staff_send incident.
       None of that was true, and it is the needs-attention queue Balal
       reads at cutover to judge whether the chain is healthy.

       auto_send is false when an AGENT-RAIL deed has no ACTIVE person to
       receive it, the only manager still being pending, say. A pending
       account cannot be opened, so emailing it would be a silent loss and
       it belongs in the same queue. Supplier and direct rails always set it
       true, so they are unaffected. */
    const deliverable = !targetErr && !!dest?.email && dest?.auto_send !== false;
    if (targetErr) {
      /* An unread ladder is not an empty one. Discarding this error made a
         transient RPC failure indistinguishable from "this agency has
         nobody", which is the last branch below, and that one writes "No
         agent contact on file" into the feed. It cannot be retried from
         here: the deed is already executed and the dedup row is committed,
         so a 500 would be deduped into nothing on redelivery. It parks with
         an HONEST reason instead, which the manual Send deed to agent
         button clears. */
      await service.from("applications").update({ awaiting_staff_send: true }).eq("id", app.id);
      await service.from("activity_log").insert({
        application_id: app.id, kind: "deed_delivery_failed",
        message: "Deed issued. Where to deliver it could not be resolved, so it is held for a staff send.",
        actor: "System", visibility: "internal",
      });
      await service.rpc("report_ops_incident", {
        p_type: "deed_delivery_target_unreadable",
        p_detail: `Application ${app.id} (${app.guarantee_ref}): the deed is executed but deed_delivery_target failed (${targetErr.message}), so it could not be delivered and is queued for a staff send.`,
      }).then(() => {}, () => {});
    } else if (deliverable && mayEmail && app.deed_delivered_at) {
      /* ONE FACT, NOT A COMPARISON ACROSS TWO HANDLERS.
         20261007640000. This used to read

           app.deed_delivered_at && !(app.deed_issued_at >
                                      app.deed_delivered_at)

         meaning "delivered, and not reissued since". The intent was
         right and the fact was wrong: `deed_issued_at` is when the
         deed was EXECUTED and it is written by THIS handler, while
         `app` was read at the top of it. So on a corrected deed the
         value in hand was the row before this completion -- nulled by
         the correction, or the previous signing seconds before the
         previous delivery -- and the test said "not reissued" about
         the very deed that had just been reissued.

         A correction now moves the delivery aside, so "has the
         CURRENT deed been delivered" is one column and there is no
         window between a write and a read in which to be wrong. */
      /* ALREADY DELIVERED, SO NOT AGAIN. Matt, 2026-10-01: "one
         delivery per signed deed unless someone presses Resend."

         PandaDoc can redeliver a completion, and the dedup row only
         covers the webhook's own retries of the same delivery id. A
         second copy of a deed somebody already has is not harmless:
         it is the agency wondering which one is current. A person
         can still resend from the screen, which says so. */
      await service.from("activity_log").insert({
        application_id: app.id,
        kind: "deed_delivered",
        message: `Completion replayed; the signed deed already went to ${app.deed_delivered_to ?? "the agent"}, so it was not sent again.`,
        actor: "System", visibility: "internal",
      });
    } else if (deliverable && mayEmail) {
      const agencyName = (Array.isArray(app.agency) ? app.agency[0]?.name : (app.agency as { name?: string } | null)?.name) ?? "";
      const sent = await deliverDeedToAgent(service, {
        appId: app.id,
        ref: app.guarantee_ref,
        tenantTitle: app.tenant_title ?? "",
        tenantName: `${app.tenant_first_name} ${app.tenant_last_name}`,
        // #8 Title-case the address line for display; postcode left raw.
        addr1: titleCaseAddress(app.prop_addr1 ?? ""),
        postcode: app.prop_postcode ?? "",
        tenancyStart: app.tenancy_start ?? null,
        agencyName,
        pdfPath: path,
      }, { email: dest.email, name: dest.display_name ?? "", also: alsoTo }, "automatic");
      // THE ONE STATE THAT COULD NEVER BE REACHED. record_delivery_attempt
      // and the four columns behind it were added by 20261005100000 to
      // separate "a send was attempted and errored" from "there was nobody
      // to send to", and then nothing in the tree ever called it: zero rows
      // on dev carry delivery_attempted_to, so my_application_delivery
      // could return 'cannot_deliver' and 'delivered' but never 'failed'.
      //
      // An agent email that Resend refuses therefore looked exactly like a
      // successful delivery: the row was not queued, the panel said
      // delivered, and the only trace was an INTERNAL activity line inside
      // deliverDeedToAgent that the agency cannot see. A failed send is the
      // agency's business, because the agency is who is waiting for the deed
      // and who can press Resend, so it is written down as a failure here.
      await service.rpc("record_delivery_attempt", {
        p_app: app.id, p_ok: sent.ok, p_to: dest.email,
        // Everyone the one email addressed, which is what the panel
        // shows under "Sent to".
        p_recipients: [dest.email, ...alsoTo].filter(Boolean).join(", "),
        p_source: dest.source ?? null,
        p_reason: sent.ok ? null : (sent.error ?? "The email provider refused the send."),
      }).then(() => {}, () => {});
    } else if (deliverable) {
      /* DELIVERABLE, BUT THIS IS SANDBOX. Nothing is wrong with the
         application and nothing needs a human, so it must not be parked:
         the only reason no email left the building is that this is not
         production. Recorded so a dev walk can still see where the deed
         would have gone. */
      await service.from("activity_log").insert({
        application_id: app.id,
        kind: "deed_delivery_suppressed",
        message: `Deed issued. Sandbox, so no email was sent; on production this would have gone to ${dest.email}.`,
        actor: "System", visibility: "internal",
      });
    } else {
      // CANNOT DELIVER: no rung of this rail's ladder carries an address, or
      // the only people who could receive it are not active yet. Nothing was
      // sent and nothing errored, so delivery_failed_at stays null and this
      // parks in the queue instead, which is the distinction 20261005100000 exists
      // to draw, and the reason this must not call record_delivery_attempt.
      const heldForPeople = !!dest?.email && dest?.auto_send === false;
      // Queryable queue, so "what is waiting for a human to send?" is a filter
      // rather than a scan of activity.
      await service.from("applications").update({ awaiting_staff_send: true }).eq("id", app.id);
      await service.from("activity_log").insert({
        application_id: app.id,
        kind: "deed_delivery_failed",
        message: heldForPeople
          ? "Deed issued; nobody active at this agency can receive it, so it is held for a staff send. Invite or activate a manager, or nominate a recipient."
          : "Deed issued. No agent contact on file, so it could not be delivered.",
        actor: "System",
        // Admin-facing, per the same ruling: there is no address, no error
        // and nothing the agency can do, so a "delivery failed" line in
        // their feed reads as a fault of ours that they must chase. It is
        // ours to clear, and awaiting_staff_send is where it is claimed.
        visibility: "internal",
      });
      // Nobody was watching for the absence of a delivery either. A paid,
      // signed deed sitting in a queue is the end of the tenant's journey
      // and the start of nothing, so it gets told to ops like the rest.
      await service.rpc("report_ops_incident", {
        p_type: "deed_awaiting_staff_send",
        p_detail: `Application ${app.id} (${app.guarantee_ref}): the deed is executed but there is nobody to deliver it to, so it is queued for a staff send.`,
      }).then(() => {}, () => {});
    }
    // Resend allows 2 req/sec; a short gap keeps the agent + tenant emails
    // (and any review-copy send inside them) from landing in the same window.
    await new Promise((r) => setTimeout(r, 600));
    // #4 Email the tenant their own signed deed (download link), regardless of
    // whether the agent contact resolved. Idempotent via the pandadoc_events
    // dedup above (document.completed runs once).
    if (mayEmail) await deliverExecutedDeedToTenant(service, {
      appId: app.id,
      ref: app.guarantee_ref,
      tenantEmail: app.tenant_email ?? "",
      tenantName: `${app.tenant_first_name ?? ""} ${app.tenant_last_name ?? ""}`.trim(),
      // #8 Title-case the address line for display; postcode left raw.
      propertyAddr: [titleCaseAddress(app.prop_addr1), app.prop_postcode].filter(Boolean).join(", "),
      tenancyStart: app.tenancy_start ?? null,
      pdfPath: path,
    });
  }
  return { ok: true };
}
