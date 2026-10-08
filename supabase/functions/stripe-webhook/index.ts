// =====================================================================
// stripe-webhook (verify_jwt = false)
//
// Stripe cannot send a Supabase JWT, so JWT verification is off and security
// is the Stripe signature (STRIPE_WEBHOOK_SECRET). Uses the service role for
// the privileged transition via apply_stripe_payment / apply_stripe_refund.
//
// Idempotency, two layers:
//  1. Each event id is inserted into stripe_events; a duplicate delivery is a
//     no-op (returns 200 without processing).
//  2. apply_stripe_payment only transitions a still-Sent application, so a
//     repeated completed event never double-transitions.
//
// Failure / abandonment (payment_intent.payment_failed, checkout.session.expired)
// leave status untouched. Refunds are recorded without reversing Sent -> Paid.
//
// LIVE AND SANDBOX ARRIVE AT THE SAME URL. Stripe sends test-mode and live-mode
// events to the same endpoint, and the mode is derived from WHICH SIGNING SECRET
// VERIFIES THE SIGNATURE, never from anything in the body. livemode is a field in
// a Stripe event, but reading it would mean trusting a value from a request whose
// authenticity is the very thing being established, so it is deliberately
// ignored. A caller who cannot forge the sandbox HMAC cannot make a live event
// look like a sandbox one.
//
// The verified mode is then cross-checked against the application's own livemode.
// They can only disagree if an event from one mode is replayed against an
// application from the other, so a mismatch is refused outright and raises an ops
// alert rather than being reconciled.
// =====================================================================
import Stripe from "npm:stripe@^17";
import { createClient } from "npm:@supabase/supabase-js@2";
import { generateDeed, voidDocument } from "../_shared/pandadoc.ts";
import { deliverRefund, deliverCancellationNotice } from "../_shared/refundEmail.ts";
import { runRefundCascade } from "../_shared/refundCascade.ts";
import { deliverPaymentReceipt } from "../_shared/paymentReceiptEmail.ts";
import { notifyReferrer } from "../_shared/referrerNotify.ts";
import { titleCaseAddress } from "../_shared/text.ts";
import { stripeSecretFor, stripeWebhookSecrets, maySendOpndoorEmail } from "../_shared/livemodeCredentials.ts";

/**
 * Refuse an event whose mode does not match the application it names.
 *
 * The two can only disagree if an event verified with one mode's signing secret
 * is processed against an application created in the other. That is either a
 * replay of a captured sandbox event against a live application id, or a
 * misconfiguration where the same secret has been set for both modes. Neither is
 * recoverable by picking one, and picking the event's mode would let a forged
 * sandbox event refund a real payment.
 *
 * Returns null when the check passes, or a Response to return immediately.
 *
 * 500 rather than 400, deliberately: 400 tells Stripe the event is permanently
 * bad and it stops retrying, which would hide a misconfiguration. A 500 keeps it
 * retrying and visible while the ops alert is dealt with.
 */
/**
 * One construction site for the Stripe client.
 *
 * There are now two: a throwaway used only to verify the signature, and the real
 * one built from the mode that verification established. The apiVersion is
 * pinned and pinning it is deliberate, so it lives here rather than being
 * repeated. (Note the pinned version does not match the types shipped by
 * stripe@17.7.0, which is a pre-existing condition at HEAD and not touched here:
 * changing it would change the wire behaviour of the live payment path.)
 */
function stripeClient(secret: string): Stripe {

  return new Stripe(secret, { httpClient: Stripe.createFetchHttpClient(), apiVersion: "2024-06-20" });
}

// deno-lint-ignore no-explicit-any
async function refuseOnModeMismatch(service: any, appId: string, eventLivemode: boolean, eventId: string): Promise<Response | null> {
  const { data: row } = await service.from("applications").select("livemode").eq("id", appId).maybeSingle();
  if (!row) return null;                       // unknown id is handled by the callers
  if ((row.livemode === true) === eventLivemode) return null;

  /* THROUGH report_ops_incident, BECAUSE THE DIRECT INSERT NEVER WROTE ANYTHING.
     ops_alerts.hour_bucket is NOT NULL with no default, so this insert failed on
     every single call, and the .then(noop, noop) swallowed the error: an alert
     for one of the two conditions that can let a sandbox event act on a live
     application, which has never once been raised. Verified on dev by running the
     insert as it stood.

     The RPC is the only correct way in regardless: it fills hour_bucket, dedups
     to one row per type per hour, and dispatches the ops-alert email. A direct
     insert would skip all three even if it worked. */
  await service.rpc("report_ops_incident", {
    p_type: "stripe_livemode_mismatch",
    p_detail: `Stripe event ${eventId} verified as ${eventLivemode ? "live" : "sandbox"} but application ${appId} is ${row.livemode ? "live" : "sandbox"}. Refused.`,
  }).then(() => {}, () => {});

  // Drop the dedup row so a corrected redelivery is not swallowed as a duplicate.
  await service.from("stripe_events").delete().eq("id", eventId).then(() => {}, () => {});

  return new Response("Event mode does not match the application.", { status: 500 });
}

Deno.serve(async (req) => {
  const candidates = stripeWebhookSecrets();
  if (candidates.length === 0) return new Response("Webhook secret not configured.", { status: 400 });

  const sig = req.headers.get("stripe-signature");
  const body = await req.text();

  // Verification is pure HMAC over the body and the signing secret; the API key
  // plays no part. So a throwaway client is enough to verify, and the real one is
  // built afterwards from the mode the signature established.
  const verifier = stripeClient("sk_unused_for_verification");
  const provider = Stripe.createSubtleCryptoProvider();

  let event: Stripe.Event | null = null;
  let eventLivemode = false;
  let lastErr = "no signing secret matched";
  for (const c of candidates) {
    try {
      event = await verifier.webhooks.constructEventAsync(body, sig!, c.secret, undefined, provider);
      eventLivemode = c.livemode;
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  if (!event) return new Response(`Signature verification failed: ${lastErr}`, { status: 400 });

  const secret = stripeSecretFor(eventLivemode);
  if (!secret.ok) return new Response(secret.error, { status: 400 });
  const stripe = stripeClient(secret.value);

  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Layer 1 idempotency: record the event id; a duplicate is skipped.
  const { error: insErr } = await service.from("stripe_events").insert({ id: event.id, type: event.type });
  if (insErr) {
    if (insErr.code === "23505") return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("Could not record event.", { status: 500 }); // let Stripe retry
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      const appId = s.metadata?.application_id ?? (typeof s.client_reference_id === "string" ? s.client_reference_id : null);
      const pi = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null;
      const amount = (s.amount_total ?? 0) / 100;
      if (appId) {
        // The privileged transition. On a transient DB error supabase-js returns an
        // error object rather than throwing, so check it: delete the dedup row (so a
        // Stripe retry re-processes rather than being deduped to a 200) and throw,
        // which the catch below turns into a 500 + ops alert. Never continue past a
        // failed transition to log/email a payment that did not actually apply.
        const refusal = await refuseOnModeMismatch(service, appId, eventLivemode, event.id);
        if (refusal) return refusal;

        // ---- WHAT IS THIS PAYMENT FOR? -----------------------------------
        //
        // Read BEFORE apply_stripe_payment, and ABSENCE MEANS GUARANTEE FEE.
        //
        // That default is load-bearing. Every session created before this code
        // shipped, and every session currently in flight, carries no purpose,
        // and all of them must keep behaving exactly as they did. Defaulting
        // the other way, or requiring the field, would turn every in-flight
        // referral payment into an error on deploy.
        //
        // The eligibility fee returns HERE and goes no further. Falling through
        // would call apply_stripe_payment, which sets status 'paid', which
        // generates a Deed of Guarantee and emails the tenant a receipt for it,
        // on a GBP 20 payment, possibly before anyone has referenced them.
        const purpose = typeof s.metadata?.purpose === "string" ? s.metadata.purpose : "guarantee";

        if (purpose === "eligibility") {
          const { error: eligErr } = await service.rpc("record_eligibility_payment", {
            p_application: appId,
            p_amount: amount,
            p_session: s.id,
            p_payment_intent: pi,
            p_livemode: eventLivemode,
          });
          if (eligErr) {
            await service.from("stripe_events").delete().eq("id", event.id);
            throw new Error(`record_eligibility_payment failed: ${eligErr.message}`);
          }
          await service.from("stripe_events").update({ application_id: appId }).eq("id", event.id);
          await service.from("activity_log").insert({
            application_id: appId,
            kind: "eligibility_paid",
            message: `Eligibility fee paid (£${amount.toLocaleString("en-GB")}) via Stripe.`,
            actor: "Stripe",
          });
          return new Response(JSON.stringify({ received: true, purpose: "eligibility" }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }

        if (purpose !== "guarantee") {
          // An unrecognised purpose is refused, not guessed. Guessing here means
          // guessing whether to issue a deed.
          await service.from("stripe_events").delete().eq("id", event.id);
          throw new Error(`Unknown payment purpose "${purpose}" on session ${s.id}`);
        }

        const { error: payErr } = await service.rpc("apply_stripe_payment", { p_application_id: appId, p_payment_intent: pi, p_amount: amount, p_session_id: s.id });
        if (payErr) {
          await service.from("stripe_events").delete().eq("id", event.id);
          throw new Error(`apply_stripe_payment failed: ${payErr.message}`);
        }
        await service.from("stripe_events").update({ application_id: appId }).eq("id", event.id);
        const { data: appRow } = await service.from("applications")
          .select("status, deed_state, guarantee_ref, tenant_title, tenant_last_name, tenant_email, prop_addr1, prop_postcode, livemode")
          .eq("id", appId).maybeSingle();
        // Idempotent post-payment side-effects, run only on the FIRST completed
        // payment for this application (a second DISTINCT Checkout event must not
        // re-log/re-generate/re-email). A prior 'payment_received' row is the marker.
        // A staff-withdrawn anomaly leaves status != 'paid', so nothing fires here.
        const { data: priorPaid } = await service.from("activity_log").select("id").eq("application_id", appId).eq("kind", "payment_received").limit(1);
        if (appRow?.status === "paid" && !priorPaid?.length) {
          await service.from("activity_log").insert({ application_id: appId, kind: "payment_received", message: `Guarantee fee paid (£${amount.toLocaleString("en-GB")}) via Stripe.`, actor: "Stripe" });
          // Generate the deed (fresh or #13 reinstated) unless one already exists.
          //
          // THE CHECK IS ON THE TENANCY, NOT ON WHOEVER JUST PAID. On a joint
          // tenancy the deed belongs to the lead applicant, so appRow.deed_state
          // is the wrong row to ask, and the last two payments can land together
          // with both seeing "everybody has paid". claim_tenancy_deed settles it
          // in the database: exactly one caller wins. A solo application resolves
          // to itself and the claim succeeds iff deed_state is null, which is the
          // condition this line has always had.
          //
          // THE ERROR AND THE REFUSAL LOOKED THE SAME. `.then(r => r.data === true)`
          // reads false for both "somebody else already claimed this" (correct,
          // do nothing) and "the RPC failed" (a paid application that gets no
          // deed and no record that one was ever attempted). supabase-js returns
          // the error rather than throwing, so the second was invisible: the
          // commonest possible cause of a deed silently not existing was the one
          // line that could not report it.
          const claim = await service.rpc("claim_tenancy_deed", { p_application: appId });
          if (claim.error) {
            // Deliberately not thrown. The payment is applied and the receipt
            // below should still go; what must not happen is the deed being
            // dropped quietly. The manual retry on the application is the
            // remedy, and this is what tells somebody to press it.
            await service.rpc("report_ops_incident", {
              p_type: "deed_claim_failed",
              p_detail: `Application ${appId}: payment applied but claim_tenancy_deed failed (${claim.error.message}), so no deed was generated. Retry the deed from the application.`,
            }).then(() => {}, () => {});
            await service.from("activity_log").insert({
              application_id: appId, kind: "deed_error",
              message: `Deed not generated: the deed claim could not be taken (${claim.error.message}). Retry from this application.`,
              actor: "System", visibility: "internal",
            });
          } else if (claim.data === true) {
            const gen = await generateDeed(service, appId);
            /* A failure must not leave the tenancy permanently claimed: a retry
               has to be able to try again. It DOES re-open the path for the next
               Stripe delivery, and that is now the point. This comment used to
               say the opposite, that deed_state 'error' would stop a redelivery
               claiming, which was true until 20261005260000 ruled that a failure
               is retried rather than buried: 'error' no longer refuses, only an
               existing document and the terminal states do.

               A redelivery cannot loop on a broken template even so, because
               three consecutive failures park the application for staff and,
               separately, two runs can no longer overlap: generateDeed holds a
               lease for the duration (20261005280000). Nothing is raised here
               either, because a refused lease means another run is already doing
               this work, which is not a fault. */
            if (!gen.ok) await service.rpc("release_tenancy_deed_claim", { p_application: appId });
          }
          // #3 Tenant payment receipt.
          // Sandbox sends no Opndoor email. The deed above is different: that is
          // PandaDoc's own watermarked document and rehearsing the tenant's
          // signing journey is the point of sandbox. This is our receipt, to an
          // address a developer typed into a test payload.
          if (appRow.tenant_email && maySendOpndoorEmail(appRow.livemode === true)) {
            const amountGBP = `£${amount.toLocaleString("en-GB", { minimumFractionDigits: amount % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
            await deliverPaymentReceipt(service, {
              appId,
              tenantEmail: appRow.tenant_email,
              title: appRow.tenant_title ?? "",
              lastName: appRow.tenant_last_name ?? "",
              // #8 Title-case the address line for display; postcode left raw.
              propertyAddr: [titleCaseAddress(appRow.prop_addr1), appRow.prop_postcode].filter(Boolean).join(", "),
              amount: amountGBP,
              guaranteeRef: appRow.guarantee_ref,
            });
          }
          // Tell the referring agent the guarantee fee has been paid.
          await notifyReferrer(service, appId, "paid");
        }
      }
    } else if (event.type === "charge.refunded") {
      const c = event.data.object as Stripe.Charge;
      const pi = typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id ?? null;
      const refundId = c.refunds?.data?.[0]?.id ?? c.id;
      if (pi) {
        const refundAmount = (c.amount_refunded ?? 0) / 100;
        // Resolve the application from the payment intent first, so the mode can
        // be checked BEFORE the refund is applied rather than after.
        const { data: pre } = await service.from("applications").select("id").eq("stripe_payment_intent_id", pi).maybeSingle();
        if (pre?.id) {
          const refusal = await refuseOnModeMismatch(service, pre.id, eventLivemode, event.id);
          if (refusal) return refusal;
        }
        /* THE ERROR WAS DISCARDED, AND THIS IS THE ONE THAT MATTERS MOST.
           supabase-js returns errors rather than throwing, and the same defect was
           fixed three hunks above for apply_stripe_payment, record_eligibility_payment
           and claim_tenancy_deed while this one was left.

           apply_stripe_refund is the only writer of payment_state = 'refunded'. If
           it fails, everything below still runs on a refund that never applied: the
           tenant is emailed a refund confirmation, the outstanding deed is voided,
           and the activity trail says "Payment refunded in Stripe", while the row
           still says the fee is paid. We answer 200, so Stripe never redelivers, and
           the stripe_events dedup row makes a manual redelivery a no-op.

           The consequence is not a stale flag. ApplicationDetail gates the deed
           controls on `paymentState !== 'refunded'`, which now passes, so Generate
           renders on a refunded application and mints a fresh Deed of Guarantee.
           apply_deed_executed's own refund guard reads payment_state too, finds it
           clean, and executes and delivers that deed to the agent as valid. A
           refunded tenant ends up guaranteed. That is DEFECTS.md 9 reopened through
           the front door.

           A 5xx is the correct answer: Stripe retries a refund event, and retrying
           an unapplied refund is exactly what we want. */
        const { error: refundErr } = await service.rpc("apply_stripe_refund", { p_payment_intent: pi, p_refund_id: refundId, p_amount: refundAmount });

        /* A PART REFUND IS REFUSED, AND THAT MUST NOT BECOME A RETRY LOOP.
           Matt's rule is that Opndoor never gives part refunds, so
           apply_stripe_refund raises 22023 on any amount that is not the
           whole fee. But Stripe has ALREADY moved the money: this function
           is recording a fact, not performing an action, and you cannot
           refuse a fact.

           Treated as an ordinary failure it would 500, Stripe would retry
           for ever, and the application would never be marked at all --
           still fully paid, commission still paid, deed still live. So this
           is matched by code, reported LOUDLY with the guarantee and the
           amount, and answered 200 so Stripe stops.

           The row then still says paid while Stripe says partly refunded.
           That divergence is deliberate and visible: somebody has to go and
           look, which is the honest handling of something the business says
           never happens. */
        if (refundErr && (refundErr as { code?: string }).code === "22023") {
          await service.rpc("report_ops_incident", {
            p_type: "stripe_partial_refund_refused",
            p_detail: `Payment intent ${pi}: Stripe reported a PART refund of ${refundAmount}. `
              + `Opndoor does not give part refunds, so nothing has been recorded and the `
              + `application still reads as paid. Refund ${refundId}. `
              + `Reconcile in Stripe and decide whether this should be a full refund.`,
          }).then(() => {}, () => {});
          return new Response(JSON.stringify({ ok: false, refused: "part_refund" }),
            { status: 200, headers: { "Content-Type": "application/json" } });
        }

        if (refundErr) {
          await service.rpc("report_ops_incident", {
            p_type: "stripe_refund_not_applied",
            p_detail: `Payment intent ${pi}: charge.refunded arrived but apply_stripe_refund failed (${refundErr.message}). Nothing downstream ran. Stripe will retry.`,
          }).then(() => {}, () => {});
          /* WAS `json(...)`, which does not exist in this file -- every other
             return here builds a Response by hand. It threw a ReferenceError
             that the outer catch turned into a 500 anyway, so Stripe still
             retried and the safety property held; what never ran was this
             intended path, and the catch logged a second, misleading incident
             on top of the accurate one just reported above. */
          return new Response(JSON.stringify({ error: "Could not apply the refund." }),
            { status: 500, headers: { "Content-Type": "application/json" } });
        }
        const { data: appRow } = await service.from("applications")
          .select("id, guarantee_ref, refund_after_start, tenant_title, tenant_last_name, tenant_email, prop_addr1, prop_postcode, pandadoc_document_id, deed_state, livemode, payment_state")
          .eq("stripe_payment_intent_id", pi).maybeSingle();
        if (appRow) {
          await service.from("activity_log").insert({ application_id: appRow.id, kind: "refunded", message: "Payment refunded in Stripe.", actor: "Stripe" });
          if (appRow.refund_after_start) {
            await service.from("activity_log").insert({ application_id: appRow.id, kind: "refund_anomaly", message: "POLICY ANOMALY: refunded on or after the tenancy start date, outside the refund policy. Review required.", actor: "System" });
          }
          /* R2. ONLY A FULL REFUND VOIDS THE DEED.
             This used to fire on any refund at all, because apply_stripe_refund
             marked every refund 'refunded' whatever the amount. It now marks a
             partial one 'partially_refunded', and a partial refund must NOT
             void an outstanding deed: the tenant is still covered, the money
             owed is still owed, and voiding it leaves a paid-for guarantee
             with no instrument behind it. Measured cause: a GBP 10 refund
             against a GBP 1,246.15 fee. */
          if (appRow.pandadoc_document_id && appRow.deed_state === "awaiting_tenant"
              && appRow.payment_state === "refunded") {
            const voidResult = await voidDocument(appRow.pandadoc_document_id, appRow.livemode === true);
            if (voidResult.ok) {
              await service.from("applications").update({ deed_state: "voided", pandadoc_document_id: null }).eq("id", appRow.id);
              await service.from("activity_log").insert({
                application_id: appRow.id,
                kind: "deed_voided",
                message: "Outstanding deed signing link expired because the payment was refunded.",
                actor: "System",
                visibility: "business",
              });
            } else {
              // DEFECTS.md 9. There was no else. A PandaDoc timeout during a
              // refund left deed_state at awaiting_tenant with the document id
              // still set, so the signing link already in the tenant's inbox
              // stayed live. apply_stripe_refund never touches status, so the
              // application was still 'paid': signing it took the ORDINARY path
              // and issued a full Deed of Guarantee, delivered to the agent as
              // valid, on an application whose fee had been refunded.
              //
              // The document is still live at PandaDoc and we cannot change that
              // from here. What we can do is make sure this portal will not
              // ACCEPT its completion, which is the half we control.
              await service.from("applications")
                .update({ deed_state: "error", pandadoc_document_id: null })
                .eq("id", appRow.id);

              await service.from("activity_log").insert({
                application_id: appRow.id,
                kind: "deed_void_failed",
                message: `Could not void the outstanding deed after a refund: ${voidResult.error ?? "no detail"}. `
                  + "The signing link may still work at PandaDoc. Void it there by hand.",
                actor: "System",
                visibility: "internal",
              });

              // Raised where operational failures already surface. Previously
              // this failure produced no log line, no activity row and no
              // incident: the only trace was the ABSENCE of the deed_voided row
              // above, which nobody was watching for.
              await service.rpc("report_ops_incident", {
                p_type: "deed_void_failed",
                p_detail: `Refund on ${appRow.guarantee_ref}: PandaDoc void failed (${voidResult.error ?? "no detail"}). `
                  + "Void the document in PandaDoc manually. The application has been set to deed_state=error.",
              }).then(() => {}, () => {});
            }
          }

          // Branded refund confirmation to the tenant (redirected to the review
          // address in test mode). Idempotent: the whole charge.refunded block
          // runs once per event via the stripe_events dedup above.
          // Whole pounds show no decimals; a partial refund shows exactly two.
          const amountGBP = `£${refundAmount.toLocaleString("en-GB", { minimumFractionDigits: refundAmount % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

          /* THE GUARANTEE ENDS. Matt (ak): "when a tenant's fee is fully
             refunded, their guarantee ends ... never 'Deed executed'."

             FULL REFUNDS ONLY, which `payment_state` already decides for us:
             apply_stripe_refund writes 'refunded' for the whole fee and
             'partially_refunded' otherwise, so testing the state rather than
             the amount keeps Matt's part-refund rule in ONE place.

             BEFORE THE EMAIL, because the email has to say whether there was
             a deed to cancel, and the honest way to know is to have tried. */
          let deedCancelled = false;
          if (appRow.payment_state === "refunded") {
            const { data: didCancel, error: cancelErr } = await service
              .rpc("cancel_guarantee_for_refund", { p_application: appRow.id });
            if (cancelErr) {
              await service.rpc("report_ops_incident", {
                p_type: "guarantee_cancel_failed",
                p_detail: `${appRow.guarantee_ref}: the fee was refunded but the Deed of Guarantee could not be cancelled (${cancelErr.message}). `
                  + `The application may still read "Deed executed" on screen. Cancel it by hand.`,
                p_application_id: appRow.id,
              }).then(() => {}, () => {});
            }
            deedCancelled = didCancel === true;
          }

          /* WAS THIS REFUND OURS OR THEIRS? Matt (bb): a tenant the cascade
             refunded needs to be told WHY, and a tenant who asked for a
             refund does not need telling the let is off.

             THE LEDGER ALREADY KNOWS. `refund_cascades` holds a row only for
             a co-tenant we refunded automatically, so its presence is the
             answer, and it is durable -- a redelivery weeks later still gets
             the same email rather than the generic one. Inferring it from
             "did a sibling get refunded first" would be a guess that goes
             wrong the moment two tenants are refunded by hand. */
          const { data: cascadeRow } = await service
            .from("refund_cascades").select("application_id")
            .eq("application_id", appRow.id).maybeSingle();
          const wasCascaded = !!cascadeRow;

          if (maySendOpndoorEmail(appRow.livemode === true)) await deliverRefund(service, {
            appId: appRow.id,
            tenantEmail: appRow.tenant_email,
            title: appRow.tenant_title ?? "",
            lastName: appRow.tenant_last_name ?? "",
            // #8 Title-case the address line for display; postcode left raw.
            propertyAddr: [titleCaseAddress(appRow.prop_addr1), appRow.prop_postcode].filter(Boolean).join(", "),
            amount: amountGBP,
            guaranteeRef: appRow.guarantee_ref,
            deedCancelled,
            cascaded: wasCascaded,
          });

          /* AND THE REST OF THE TENANCY. Matt (al): "the tenancy isn't going
             ahead, so automatically refund every other paid tenant on that
             tenancy through Stripe."

             LAST, DELIBERATELY. Every step above concerns the tenant whose
             refund this event is about, and each of them must have happened
             before we start moving other people's money -- if the cascade
             throws, the tenant who was actually refunded has still had their
             guarantee cancelled and still been told.

             THE CASCADE DOES NOT CANCEL DEEDS OR SEND TENANT EMAILS. Each
             refund it takes raises its own charge.refunded event, which
             arrives here and runs everything above for that co-tenant. One
             code path for "a tenant was refunded", whether a person did it
             in Stripe or we did it automatically.

             NEVER FAILS THE WEBHOOK. A 5xx here would have Stripe redeliver
             an event whose refund HAS been applied, and the resend buys
             nothing the ledger does not already give us: the open rows are
             swept by the next refund event, and any failure is on Home and
             with ops already. */
          if (appRow.payment_state === "refunded") {
            try {
              await service.rpc("start_refund_cascade", { p_trigger: appRow.id });
              const outcome = await runRefundCascade(service, stripe);
              if (outcome.refunded.length || outcome.failed.length || outcome.skipped.length) {
                console.log("[opndoor] refund cascade", JSON.stringify(outcome));
              }
            } catch (e) {
              await service.rpc("report_ops_incident", {
                p_type: "refund_cascade_failed",
                p_detail: `${appRow.guarantee_ref}: the co-tenant refund cascade could not run (${e instanceof Error ? e.message : String(e)}). `
                  + `Check refund_cascades for open rows and refund the remaining tenants by hand if needed.`,
                p_application_id: appRow.id,
              }).then(() => {}, () => {});
            }

            /* ONE EMAIL FOR THE PROPERTY, AND ONCE. Matt (al): "one email
               listing every tenant on the tenancy and saying all guarantees
               for the property are cancelled." Matt (bc), after it went
               twice: "Send it exactly once per tenancy, after the last
               tenant's refund, and never again on webhook redeliveries."

               MY BUG, AND THE CAUSE WAS THE THING I WAS PLEASED ABOUT. Each
               cascaded refund raises its own charge.refunded and runs this
               whole block, deliberately, so a refund taken by hand and one
               taken by the cascade go down one path. Everything else in
               here is per TENANT and belongs on that path. This is per
               PROPERTY and did not.

               THE CLAIM ANSWERS BOTH HALVES. `claim_cancellation_notice`
               returns true only when no paid tenant on the tenancy is still
               unrefunded (it is time) AND no row has been written for it
               before (it has not been done). The insert is the claim, so
               two co-tenants' webhooks landing together cannot both win,
               and a redelivery next week still finds the row. */
            if (maySendOpndoorEmail(appRow.livemode === true)) {
              const { data: mayNotify } = await service
                .rpc("claim_cancellation_notice", { p_application: appRow.id });
              if (mayNotify === true) {
                await deliverCancellationNotice(service, appRow.id, appRow.guarantee_ref);
              }
            }
          }
        }
      }
    }
    // payment_intent.payment_failed / checkout.session.expired: acknowledged, no status change.
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // #3 A webhook processing failure alerts ops (deduped to one per hour).
    try { await service.rpc("report_ops_incident", { p_type: "webhook_error", p_detail: `stripe-webhook ${event?.type ?? "?"}: ${msg}` }); } catch { /* never mask the original failure */ }
    return new Response("Webhook processing failed.", { status: 500 });
  }
});
