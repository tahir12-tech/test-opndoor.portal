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
// TEST MODE ONLY: refuses to run unless STRIPE_SECRET_KEY is an sk_test_ key.
// =====================================================================
import Stripe from "npm:stripe@^17";
import { createClient } from "npm:@supabase/supabase-js@2";
import { generateDeed, voidDocument } from "../_shared/pandadoc.ts";
import { deliverRefund } from "../_shared/refundEmail.ts";
import { deliverPaymentReceipt } from "../_shared/paymentReceiptEmail.ts";
import { titleCaseAddress } from "../_shared/text.ts";

Deno.serve(async (req) => {
  const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!STRIPE_SECRET.startsWith("sk_test_")) return new Response("Test mode only (sk_test_ required).", { status: 400 });
  if (!WEBHOOK_SECRET) return new Response("Webhook secret not configured.", { status: 400 });

  const stripe = new Stripe(STRIPE_SECRET, { httpClient: Stripe.createFetchHttpClient(), apiVersion: "2024-06-20" });
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider());
  } catch (e) {
    return new Response(`Signature verification failed: ${e instanceof Error ? e.message : String(e)}`, { status: 400 });
  }

  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Layer 1 idempotency: record the event id; a duplicate is skipped.
  const { error: insErr } = await service.from("stripe_events").insert({ id: event.id, type: event.type });
  if (insErr) {
    if (insErr.code === "23505") return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(`Could not record event: ${insErr.message}`, { status: 500 }); // let Stripe retry
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
        const { error: payErr } = await service.rpc("apply_stripe_payment", { p_application_id: appId, p_payment_intent: pi, p_amount: amount, p_session_id: s.id });
        if (payErr) {
          await service.from("stripe_events").delete().eq("id", event.id);
          throw new Error(`apply_stripe_payment failed: ${payErr.message}`);
        }
        await service.from("stripe_events").update({ application_id: appId }).eq("id", event.id);
        const { data: appRow } = await service.from("applications")
          .select("status, deed_state, guarantee_ref, tenant_title, tenant_last_name, tenant_email, prop_addr1, prop_postcode")
          .eq("id", appId).maybeSingle();
        // Idempotent post-payment side-effects, run only on the FIRST completed
        // payment for this application (a second DISTINCT Checkout event must not
        // re-log/re-generate/re-email). A prior 'payment_received' row is the marker.
        // A staff-withdrawn anomaly leaves status != 'paid', so nothing fires here.
        const { data: priorPaid } = await service.from("activity_log").select("id").eq("application_id", appId).eq("kind", "payment_received").limit(1);
        if (appRow?.status === "paid" && !priorPaid?.length) {
          await service.from("activity_log").insert({ application_id: appId, kind: "payment_received", message: `Guarantor fee paid (£${amount.toLocaleString("en-GB")}) via Stripe.`, actor: "Stripe" });
          // Generate the deed (fresh or #13 reinstated) unless one already exists.
          if (!appRow.deed_state) await generateDeed(service, appId);
          // #3 Tenant payment receipt.
          if (appRow.tenant_email) {
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
        }
      }
    } else if (event.type === "charge.refunded") {
      const c = event.data.object as Stripe.Charge;
      const pi = typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id ?? null;
      const refundId = c.refunds?.data?.[0]?.id ?? c.id;
      if (pi) {
        const refundAmount = (c.amount_refunded ?? 0) / 100;
        await service.rpc("apply_stripe_refund", { p_payment_intent: pi, p_refund_id: refundId, p_amount: refundAmount });
        const { data: appRow } = await service.from("applications")
          .select("id, guarantee_ref, refund_after_start, tenant_title, tenant_last_name, tenant_email, prop_addr1, prop_postcode, pandadoc_document_id, deed_state")
          .eq("stripe_payment_intent_id", pi).maybeSingle();
        if (appRow) {
          await service.from("activity_log").insert({ application_id: appRow.id, kind: "refunded", message: "Payment refunded in Stripe.", actor: "Stripe" });
          if (appRow.refund_after_start) {
            await service.from("activity_log").insert({ application_id: appRow.id, kind: "refund_anomaly", message: "POLICY ANOMALY: refunded on or after the tenancy start date, outside the refund policy. Review required.", actor: "System" });
          }
          if (appRow.pandadoc_document_id && appRow.deed_state === "awaiting_tenant") {
            const voidResult = await voidDocument(appRow.pandadoc_document_id);
            if (voidResult.ok) {
              await service.from("applications").update({ deed_state: "voided", pandadoc_document_id: null }).eq("id", appRow.id);
              await service.from("activity_log").insert({
                application_id: appRow.id,
                kind: "deed_voided",
                message: "Outstanding deed signing link expired because the payment was refunded.",
                actor: "System",
                visibility: "business",
              });
            }
          }
          // Branded refund confirmation to the tenant (redirected to the review
          // address in test mode). Idempotent: the whole charge.refunded block
          // runs once per event via the stripe_events dedup above.
          // Whole pounds show no decimals; a partial refund shows exactly two.
          const amountGBP = `£${refundAmount.toLocaleString("en-GB", { minimumFractionDigits: refundAmount % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
          await deliverRefund(service, {
            appId: appRow.id,
            tenantEmail: appRow.tenant_email,
            title: appRow.tenant_title ?? "",
            lastName: appRow.tenant_last_name ?? "",
            // #8 Title-case the address line for display; postcode left raw.
            propertyAddr: [titleCaseAddress(appRow.prop_addr1), appRow.prop_postcode].filter(Boolean).join(", "),
            amount: amountGBP,
            guaranteeRef: appRow.guarantee_ref,
          });
        }
      }
    }
    // payment_intent.payment_failed / checkout.session.expired: acknowledged, no status change.
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // #3 A webhook processing failure alerts ops (deduped to one per hour).
    try { await service.rpc("report_ops_incident", { p_type: "webhook_error", p_detail: `stripe-webhook ${event?.type ?? "?"}: ${msg}` }); } catch { /* never mask the original failure */ }
    return new Response(`Handler error: ${msg}`, { status: 500 });
  }
});
