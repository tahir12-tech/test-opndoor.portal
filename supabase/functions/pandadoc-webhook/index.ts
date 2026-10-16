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
import { verifyWebhook } from "../_shared/pandadoc.ts";
import { completeSignedDeed, COMPLETION_APP_COLUMNS } from "../_shared/deedCompletion.ts";

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
        .select(COMPLETION_APP_COLUMNS)
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
        /* THE SEQUENCE ITSELF NOW LIVES IN _shared/deedCompletion.ts, because
           deed-sweep runs it too. A completion whose callback never arrived --
           this function redeploying mid-delivery, a rotated shared key, a
           subscription edited in PandaDoc -- is reconciled from PandaDoc's own
           document status within the hour, and it has to reach the same end
           state by the same code rather than by a second implementation of it
           that drifts. Nothing about the behaviour here changed in the move.

           What is left in this handler is its half of the contract: a
           retryable failure becomes a throw, which the catch below turns into a
           500 so PandaDoc redelivers. The helper has already dropped the dedup
           row, so that redelivery is reprocessed rather than deduped into a
           200. A refusal that is not retryable (the application was refunded)
           comes back ok, keeps its dedup row, and has raised its own alert. */
        const done = await completeSignedDeed(service, app, docId, eventLivemode);
        if (!done.ok) throw new Error(done.error);
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
