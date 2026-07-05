// =====================================================================
// create-referral (verify_jwt = true)
//
// The "send" is the whole flow: create the application (Sent) via the
// validated create_referral RPC (as the caller, so RLS + field validation
// apply), open a Stripe test-mode Checkout Session for the guarantor fee,
// store the payment refs, and email the tenant the branded payment email
// (redirected to the review address in test mode). Graceful degradation: if
// Resend is not configured the application and checkout still succeed and the
// response reports emailSent = false with a reason.
//
// TEST MODE ONLY: refuses to run unless STRIPE_SECRET_KEY is an sk_test_ key.
// =====================================================================
import Stripe from "npm:stripe@^17";
import { createClient } from "npm:@supabase/supabase-js@2";
import { paymentEmailTemplate, sendEmail } from "./email.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
    if (!STRIPE_SECRET.startsWith("sk_test_")) {
      return json({ ok: false, error: "Stripe is not configured for test mode. An sk_test_ key is required." }, 400);
    }
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ ok: false, error: "Not authenticated." }, 401);

    const b = await req.json();
    const origin = String(b.origin ?? Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");

    // Caller-scoped client: RLS + create_referral field validation + AAL2 all apply.
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });

    const { data: userData } = await userClient.auth.getUser();
    const actorId = userData.user?.id;
    let actor = "A user";
    if (actorId) {
      const { data: prof } = await userClient.from("users").select("full_name").eq("id", actorId).maybeSingle();
      if (prof?.full_name) actor = prof.full_name;
    }

    // Resolve the partner (by slug) the picker chose, so a same-named agency
    // under two partners resolves to the intended one (#66) rather than an
    // arbitrary name match. Partner users are RLS-scoped to their own partner
    // anyway; the extra filter is harmless for them.
    let partnerId: string | null = null;
    if (b.partner) {
      const { data: p } = await userClient.from("partners").select("id").eq("slug", b.partner).maybeSingle();
      partnerId = p?.id ?? null;
    }
    let branchQuery = userClient
      .from("branches").select("id, partner_id, agencies!inner(name)").eq("name", b.branch).eq("agencies.name", b.agency);
    if (partnerId) branchQuery = branchQuery.eq("partner_id", partnerId);
    const { data: branch, error: brErr } = await branchQuery.limit(1).maybeSingle();
    if (brErr) return json({ ok: false, error: brErr.message }, 400);

    // Resolve the target branch; if it does not exist yet, create the agency/branch
    // on the fly and capture the agency-default contact. A partner user's records
    // land pending_review under their own partner; an opndoor admin's land
    // confirmed (the admin creation IS the review) under p_partner_slug - the
    // admin's selected partner scope. The RPC is idempotent (case-insensitive).
    let branchId = branch?.id as string | undefined;
    if (!branchId) {
      const { data: targetId, error: tErr } = await userClient.rpc("create_referral_target", {
        p_agency: b.agency,
        p_branch: b.branch,
        p_agency_email: b.agencyContactEmail ?? null,
        p_agency_contact_name: b.agencyContactName ?? null,
        p_agency_phone: b.agencyContactPhone ?? null,
        p_branch_email: b.branchContactEmail ?? null,
        p_partner_slug: b.partner ?? null,
      });
      if (tErr) return json({ ok: false, error: tErr.message }, 400);
      branchId = targetId as string;
    }

    const { data: appRes, error: rpcErr } = await userClient.rpc("create_referral", {
      p_branch: branchId, p_tenant_title: b.title, p_first: b.firstName, p_last: b.lastName, p_dob: b.dob,
      p_email: b.email, p_phone: b.phone, p_addr1: b.addr1, p_addr2: b.addr2 ?? null, p_city: b.city,
      p_county: b.county ?? null, p_postcode: b.postcode, p_rent: b.rent, p_tenancy_start: b.tenancyStart,
    });
    if (rpcErr) return json({ ok: false, error: rpcErr.message }, 400);
    const app = Array.isArray(appRes) ? appRes[0] : appRes;

    const appId = app.id as string;
    const ref = app.guarantee_ref as string;
    const rent = Number(app.monthly_rent);
    const tenantEmail = app.tenant_email as string;
    const tenantTitle = (app.tenant_title as string) ?? "";
    const tenantLast = app.tenant_last_name as string;
    const propertyAddr = [app.prop_addr1, app.prop_postcode].filter(Boolean).join(", ");
    const amountGBP = `£${rent.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

    // Stripe test-mode Checkout Session for the guarantor fee (one month's rent).
    const stripe = new Stripe(STRIPE_SECRET, { httpClient: Stripe.createFetchHttpClient(), apiVersion: "2024-06-20" });
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "gbp",
          unit_amount: Math.round(rent * 100),
          product_data: { name: `Guarantor fee - ${ref}`, description: "One month's rent, for the opndoor Deed of Guarantee." },
        },
        quantity: 1,
      }],
      metadata: { application_id: appId, guarantee_ref: ref },
      client_reference_id: appId,
      // Public, unauthenticated tenant pages (the tenant is not a portal user).
      // {CHECKOUT_SESSION_ID} is substituted by Stripe and keys the confirmation.
      success_url: `${origin}/pay/confirmed?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pay/retry?session_id={CHECKOUT_SESSION_ID}`,
    });

    const service = createClient(SUPABASE_URL, SERVICE);
    await service.from("applications").update({
      stripe_checkout_session_id: session.id, payment_url: session.url, payment_state: "awaiting",
    }).eq("id", appId);
    await service.from("activity_log").insert({ application_id: appId, kind: "referral_created", message: "Referral created and sent to the tenant.", actor });

    // #1 The payment email now points at the opndoor-hosted confirmation page
    // (/pay?token=...), not the raw Stripe URL. The page's Pay button mints a fresh
    // checkout session. utm_source tags the touch (initial send).
    const { data: pageToken } = await service.rpc("mint_payment_page_token", { p_ref: ref });
    const payUrl = pageToken ? `${origin}/pay?token=${pageToken}&utm_source=initial` : session.url!;

    // Branded payment email (redirected to the review address in test mode).
    const tpl = paymentEmailTemplate({ title: tenantTitle, lastName: tenantLast, propertyAddr, guaranteeRef: ref, amount: amountGBP, payUrl, intendedFor: tenantEmail });
    const emailRes = await sendEmail({ subject: tpl.subject, html: tpl.html });
    // Partner-safe business message; the test-mode redirect target stays admin-only
    // (a separate internal entry), so no partner-facing surface exposes the review
    // address regardless of how it renders the log.
    await service.from("activity_log").insert({
      application_id: appId,
      kind: emailRes.ok ? "payment_email_sent" : "payment_email_failed",
      message: emailRes.ok ? "Payment email sent to the tenant." : `Payment email not sent: ${emailRes.error}`,
      actor: "System",
      visibility: emailRes.ok ? "business" : "internal",
    });
    if (emailRes.ok && emailRes.to) {
      await service.from("activity_log").insert({
        application_id: appId,
        kind: "payment_email_sent",
        message: `Redirected to ${emailRes.to} (test mode).`,
        actor: "System",
        visibility: "internal",
      });
    }

    return json({ ok: true, ref, paymentUrl: session.url, emailSent: emailRes.ok, emailError: emailRes.ok ? null : emailRes.error });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error creating the referral." }, 500);
  }
});
