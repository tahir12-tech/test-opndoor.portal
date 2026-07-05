// =====================================================================
// resend-payment-email (verify_jwt = true)
//
// Resends the branded payment email for an existing Sent application, reusing
// its existing Checkout link. Allowed for anyone who can see the application
// (owning Referrer, Management in-partner, opndoor admin) - enforced by RLS on
// the caller-scoped read. Redirected to the review address in test mode. Each
// resend is written to the activity log.
//
// email.ts is the same shared module used by create-referral.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { paymentEmailTemplate, sendEmail } from "./email.ts";
import { titleCaseAddress } from "../_shared/text.ts";

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
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ ok: false, error: "Not authenticated." }, 401);

    const { ref } = await req.json();
    if (!ref) return json({ ok: false, error: "Missing application reference." }, 400);

    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    let actor = "A user";
    if (userData.user?.id) {
      const { data: prof } = await userClient.from("users").select("full_name").eq("id", userData.user.id).maybeSingle();
      if (prof?.full_name) actor = prof.full_name;
    }

    // RLS ensures only the owning Referrer / Management in-partner / admin can read it.
    const { data: app, error } = await userClient
      .from("applications")
      .select("id, guarantee_ref, tenant_title, tenant_first_name, tenant_last_name, tenant_email, prop_addr1, prop_postcode, monthly_rent, status, payment_url")
      .eq("guarantee_ref", ref).maybeSingle();
    if (error) return json({ ok: false, error: error.message }, 400);
    if (!app) return json({ ok: false, error: "Application not found, or you do not have access to it." }, 404);
    if (app.status !== "sent") return json({ ok: false, error: "This application has already been paid; there is nothing to resend." }, 400);
    if (!app.payment_url) return json({ ok: false, error: "No payment link exists for this application yet." }, 400);

    const rent = Number(app.monthly_rent);
    // #8 Title-case the address line for display in the email; postcode left raw.
    const propertyAddr = [titleCaseAddress(app.prop_addr1), app.prop_postcode].filter(Boolean).join(", ");
    const service = createClient(SUPABASE_URL, SERVICE);

    // #1 Point the resend at the opndoor confirmation page (/pay?token=...), not the
    // raw Stripe link; the page mints a fresh checkout session on demand.
    const origin = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
    const { data: pageToken } = await service.rpc("mint_payment_page_token", { p_ref: app.guarantee_ref });
    const payUrl = pageToken && origin ? `${origin}/pay?token=${pageToken}&utm_source=resend` : app.payment_url;

    const tpl = paymentEmailTemplate({
      title: app.tenant_title ?? "",
      lastName: app.tenant_last_name,
      propertyAddr,
      guaranteeRef: app.guarantee_ref,
      amount: `£${rent.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`,
      payUrl,
      intendedFor: app.tenant_email,
    });
    const emailRes = await sendEmail({ subject: tpl.subject, html: tpl.html });
    // Partner-safe business message; test-mode redirect target stays admin-only.
    await service.from("activity_log").insert({
      application_id: app.id,
      kind: emailRes.ok ? "payment_email_resent" : "payment_email_failed",
      message: emailRes.ok ? `Payment email resent to the tenant by ${actor}.` : `Payment email resend failed: ${emailRes.error}`,
      actor,
      // A failure carries the raw provider error, so keep it opndoor-admin-only
      // (the partner-safe copy is shown on the payment card). Success is business.
      visibility: emailRes.ok ? "business" : "internal",
    });
    if (emailRes.ok && emailRes.to) {
      await service.from("activity_log").insert({
        application_id: app.id,
        kind: "payment_email_resent",
        message: `Redirected to ${emailRes.to} (test mode).`,
        actor,
        visibility: "internal",
      });
    }

    if (!emailRes.ok) return json({ ok: false, error: emailRes.error }, 200);
    return json({ ok: true, to: emailRes.to });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
