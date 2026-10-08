// =====================================================================
// pandadoc-webhook (verify_jwt = false)
//
// PandaDoc cannot send a Supabase JWT, so JWT verification is off and security
// is the PandaDoc HMAC signature (PANDADOC_WEBHOOK_SHARED_KEY). Service-role
// transition via apply_deed_executed (the deed twin of apply_stripe_payment).
//
// Idempotent: a document reaching a given status is processed once
// (pandadoc_events). Document completed -> download + store the executed PDF
// and flip Paid to Deed Issued. Voided / declined set the deed sub-state and
// log for review; no status change. Other statuses are acknowledged.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyWebhook, downloadPdf } from "../_shared/pandadoc.ts";
import { deliverDeedToAgent } from "../_shared/deedEmail.ts";
import { deliverExecutedDeedToTenant } from "../_shared/executedDeedEmail.ts";
import { maySendOpndoorEmail } from "../_shared/livemodeCredentials.ts";
import { titleCaseAddress } from "../_shared/text.ts";

Deno.serve(async (req) => {
  const signature = new URL(req.url).searchParams.get("signature") ?? "";
  const body = await req.text();
  // The shared key that verifies the HMAC is what tells us which PandaDoc account
  // sent this. Nothing in the body is trusted for that: a callback is an
  // unauthenticated request until the signature checks out, so any field inside it
  // is a claim rather than a fact.
  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const verified = await verifyWebhook(body, signature);
  if (!verified.ok) {
    // A 401 HERE IS THE QUIETEST WAY A DEED CAN DIE.
    //
    // Nothing downstream is watching for the ABSENCE of a callback. If
    // PANDADOC_WEBHOOK_SHARED_KEY is unset or has been rotated on one side only,
    // every completion in the estate 401s, every deed stays at
    // 'awaiting_tenant' for ever, and the portal's own record of that is a
    // status code returned to PandaDoc and thrown away. The tenant signed, the
    // agent is waiting, and there is no row anywhere that says so.
    //
    // report_ops_incident is deduped to one row per type per hour, so a broken
    // key raises one alert an hour rather than one per callback, and an
    // internet-background probe costs one row and no more.
    await service.rpc("report_ops_incident", {
      p_type: "pandadoc_signature_rejected",
      p_detail: signature
        ? "A PandaDoc callback failed HMAC verification. If deeds are stuck at awaiting_tenant, PANDADOC_WEBHOOK_SHARED_KEY does not match the shared key on the PandaDoc webhook subscription."
        : "A request reached pandadoc-webhook with no signature parameter. If this repeats, the PandaDoc subscription is configured without HMAC signing.",
    }).then(() => {}, () => {});
    return new Response("Invalid signature", { status: 401 });
  }
  const eventLivemode = verified.livemode === true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let events: any[];
  try {
    const parsed = JSON.parse(body);
    events = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return new Response("Bad body", { status: 400 });
  }

  // The whole batch runs inside one guard, for the same reason stripe-webhook's
  // does. Two paths in here throw deliberately so PandaDoc retries (a dedup
  // insert that is not a duplicate, and apply_deed_executed refusing), and
  // without a catch they escaped as an unhandled rejection: still a 500, so the
  // retry worked, but with nothing recorded anywhere and no alert. The retry
  // then succeeds or does not, and either way nobody learns that a deed spent
  // the afternoon failing to execute.
  try {
    for (const ev of events) {
      const docId = ev?.data?.id;
      const status = ev?.data?.status;
      const type = ev?.event ?? ev?.event_type ?? "unknown";
      if (!docId) continue;

      const evId = `${docId}:${status ?? type}`;
      const { error: insErr } = await service.from("pandadoc_events").insert({ id: evId, type });
      if (insErr) {
        // ONLY A DUPLICATE IS A SKIP. This read every insert failure as one, which
        // is the same defect stripe-webhook already fixed on its own dedup line
        // (23505 there, everything else a 500 so Stripe retries). Here a transient
        // insert failure skipped the event, the handler still answered 200, and
        // PandaDoc marked delivery successful and never sent it again: a signed
        // deed lost permanently on a blip, leaving the application at
        // 'awaiting_tenant' with the tenant's signature already on the document.
        if (insErr.code === "23505") continue;
        throw new Error(`Could not record PandaDoc event ${evId}: ${insErr.message}`);
      }

      const { data: app, error: appErr } = await service.from("applications")
        .select("id, guarantee_ref, branch_id, tenant_title, tenant_first_name, tenant_last_name, tenant_email, prop_addr1, prop_postcode, tenancy_start, livemode, deed_delivered_at, deed_delivered_to, deed_issued_at, agency:agencies(name)")
        .eq("pandadoc_document_id", docId).maybeSingle();
      /* "COULD NOT LOOK IT UP" IS NOT "IT IS NOT OURS", and conflating the two
         loses signed deeds. The error was discarded, so a transient read failure
         left `app` undefined, and undefined is exactly what an unknown document
         looks like: a completion then fell into the unknown-document branch
         below, raised an alert blaming a superseded document or a misconfigured
         webhook key, wrote its dedup row and answered 200. The deed is signed,
         the application never learns, and PandaDoc will not send it again.

         It is retryable, so it is retried: drop the dedup row and throw, which
         the handler turns into a 500 and PandaDoc redelivers. */
      if (appErr) {
        await service.from("pandadoc_events").delete().eq("id", evId).then(() => {}, () => {});
        throw new Error(`Could not look up the application for PandaDoc document ${docId}: ${appErr.message}`);
      }

      // Refuse a callback whose mode does not match the application it names. The
      // two can only disagree if a sandbox event is replayed against a live
      // application or the same shared key has been configured for both modes.
      // Neither is recoverable by choosing one, and choosing the event's mode would
      // let a forged sandbox callback mark a real deed executed.
      //
      // The dedup row is deleted so a corrected redelivery is not swallowed, and
      // this returns 500 rather than 401 so PandaDoc keeps retrying and the
      // misconfiguration stays visible instead of being silently dropped.
      if (app && (app.livemode === true) !== eventLivemode) {
        /* THROUGH report_ops_incident: ops_alerts.hour_bucket is NOT NULL with no
           default, so this direct insert failed on every call and the
           .then(noop, noop) swallowed it. The alert for "a sandbox callback is
           being replayed against a live application, or one shared key is
           configured for both modes" has never been raised in its life. The RPC
           fills hour_bucket, dedups hourly and sends the ops email. */
        await service.rpc("report_ops_incident", {
          p_type: "pandadoc_livemode_mismatch",
          p_detail: `PandaDoc event ${evId} verified as ${eventLivemode ? "live" : "sandbox"} but application ${app.id} is ${app.livemode ? "live" : "sandbox"}. Refused.`,
        }).then(() => {}, () => {});
        await service.from("pandadoc_events").delete().eq("id", evId).then(() => {}, () => {});
        return new Response("Event mode does not match the application.", { status: 500 });
      }

      if (status === "document.completed" && !app) {
        // A SIGNED DEED WE CANNOT PLACE, and until now the single quietest event
        // in the chain: apply_deed_executed matches on pandadoc_document_id and
        // returns silently when it finds nothing, so this arrived, was deduped,
        // and vanished. On dev, 27 of the 28 completions ever received match no
        // application, which is how the shape was found at all.
        //
        // Two causes, and the alert has to name both because they are opposite
        // problems. Benign: a superseded document, whose id pandadoc-void-
        // regenerate deliberately cleared so exactly this would be inert. A
        // tenant signed a deed that no longer counts, which is worth knowing.
        // Not benign: this environment's shared key verifies callbacks for
        // documents belonging to ANOTHER environment, which means one PandaDoc
        // subscription is pointed at the wrong portal and the deeds that belong
        // to the other one are being answered 200 here and never delivered there.
        //
        // The download is skipped rather than merely unused. It was issued before
        // this check and its result thrown away, which pulled an executed Deed of
        // Guarantee belonging to someone else into this function for no purpose.
        await service.rpc("report_ops_incident", {
          p_type: "pandadoc_completed_unknown_document",
          p_detail: `PandaDoc document ${docId} completed but matches no application. Either it was superseded (void-and-regenerate clears the id) or this project's PANDADOC_WEBHOOK_SHARED_KEY is verifying another environment's callbacks, in which case that environment's deeds are not being executed.`,
        }).then(() => {}, () => {});
        continue;
      }

      if (status === "document.completed") {
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
          if (!pdf.ok || !pdf.bytes) {
            await service.rpc("report_ops_incident", {
              p_type: "deed_pdf_unavailable",
              p_detail: `Application ${app.id} (${app.guarantee_ref}): the tenant signed deed ${docId} but the executed PDF could not be downloaded from PandaDoc (${pdf.error}). The deed has NOT been executed and PandaDoc will redeliver. If this repeats for more than an hour, the PDF is not being rendered and the deed must be executed by hand.`,
            }).then(() => {}, () => {});
            await service.from("pandadoc_events").delete().eq("id", evId).then(() => {}, () => {});
            throw new Error(`Executed PDF for ${docId} could not be downloaded: ${pdf.error}`);
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
            throw new Error(`Executed PDF for ${docId} could not be stored: ${upErr.message}`);
          }
        }
        // supabase-js returns a DB error object rather than throwing: check it, or a
        // transient failure would leave the deed un-executed while the "signed and
        // issued" emails below still send. Delete the dedup row (so a PandaDoc retry
        // re-processes rather than being deduped) and throw -> 500 -> retry.
        const { data: execOutcome, error: execErr } = await service.rpc("apply_deed_executed", { p_document_id: docId, p_pdf_path: path });
        if (execErr) {
          await service.from("pandadoc_events").delete().eq("id", evId);
          throw new Error(`apply_deed_executed failed: ${execErr.message}`);
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
          continue;
        }
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
      } else if (status === "document.viewed") {
        if (app) {
          // First view only: the event id (docId:document.viewed) is deduplicated
          // above, and the null guard is a second safeguard.
          await service.from("applications").update({ deed_viewed_at: new Date().toISOString() }).eq("id", app.id).is("deed_viewed_at", null);
          await service.from("activity_log").insert({ application_id: app.id, kind: "deed_viewed", message: "Deed viewed by the tenant.", actor: "PandaDoc", visibility: "business" });
          await service.from("pandadoc_events").update({ application_id: app.id }).eq("id", evId);
        }
      } else if (status === "document.voided") {
        await service.rpc("set_deed_state", { p_document_id: docId, p_state: "voided" });
        if (app) await service.from("activity_log").insert({ application_id: app.id, kind: "deed_voided", message: "Deed document voided in PandaDoc. Review required.", actor: "PandaDoc" });
      } else if (status === "document.declined") {
        await service.rpc("set_deed_state", { p_document_id: docId, p_state: "declined" });
        if (app) await service.from("activity_log").insert({ application_id: app.id, kind: "deed_declined", message: "Tenant declined to sign the deed. Review required.", actor: "PandaDoc" });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await service.rpc("report_ops_incident", { p_type: "webhook_error", p_detail: `pandadoc-webhook: ${msg}` });
    } catch { /* never mask the original failure */ }
    // 500 so PandaDoc redelivers. The dedup rows for anything that failed have
    // already been removed by the path that failed, so a redelivery reprocesses
    // rather than being deduped into a 200.
    return new Response(`Handler error: ${msg}`, { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
