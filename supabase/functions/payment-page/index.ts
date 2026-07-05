// =====================================================================
// payment-page (verify_jwt = false)
//
// #1 Backend for the public tenant payment confirmation page (/pay?token=...).
// Security is the application-scoped token (payment_page_tokens), not a login; the
// tenant is never a portal user. Three actions:
//   view     - validate the token, log the first view, return public-safe data.
//   checkout - create a fresh Stripe Checkout Session (robust to link expiry and
//              the #13 expired-reinstate case) and return its URL to redirect to.
//   decline  - #14 tenant self-decline: withdraw the application (tenant-flagged),
//              idempotent and token-scoped, returning the resulting status.
// No email/PII beyond what the tenant already received is returned.
// =====================================================================
import Stripe from "npm:stripe@^17";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function ddmmyyyy(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
// Guarantee expiry = tenancy start + 12 months - 1 day.
function guaranteeExpiryLabel(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1] + 1, +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() - 1);
  return ddmmyyyy(d.toISOString());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
    const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
    const service = createClient(SUPABASE_URL, SERVICE);

    const body = await req.json().catch(() => ({}));
    const token = String(body.token ?? "");
    const action = String(body.action ?? "view");
    if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ ok: false, error: "Missing or invalid token." }, 400);

    // Resolve the token -> application (service role; the token is the authorisation).
    const { data: tok } = await service.from("payment_page_tokens")
      .select("application_id, guarantee_ref, expires_at, first_viewed_at")
      .eq("token", token).maybeSingle();
    if (!tok) return json({ ok: false, error: "This link is not valid." }, 404);
    if (new Date(tok.expires_at).getTime() < Date.now()) return json({ ok: false, error: "This link has expired." }, 410);

    const { data: app } = await service.from("applications")
      .select("id, guarantee_ref, tenant_title, tenant_first_name, tenant_last_name, prop_addr1, prop_addr2, prop_city, prop_postcode, monthly_rent, tenancy_start, status, payment_state, partner:partners(name)")
      .eq("id", tok.application_id).maybeSingle();
    if (!app) return json({ ok: false, error: "This link is not valid." }, 404);

    // deno-lint-ignore no-explicit-any
    const partnerName = (Array.isArray(app.partner) ? (app.partner as any)[0]?.name : (app.partner as any)?.name) ?? "your letting agent";
    const rent = Number(app.monthly_rent ?? 0);
    const feeGBP = `£${rent.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
    const tenantName = [app.tenant_title, app.tenant_first_name, app.tenant_last_name].filter((x) => (x ?? "").toString().trim()).join(" ").trim();
    const propFull = [app.prop_addr1, app.prop_addr2, app.prop_city, app.prop_postcode].filter(Boolean).join(", ");
    const isPaid = app.status === "paid" || app.status === "deed" || app.payment_state === "paid";
    const isExpired = app.status === "expired";
    const payable = app.status === "sent" || app.status === "expired";

    const publicData = {
      ref: app.guarantee_ref,
      partnerName,
      tenantName,
      tenantTitle: app.tenant_title ?? "",
      addr1: app.prop_addr1 ?? "",
      postcode: app.prop_postcode ?? "",
      propFull,
      tenancyStart: ddmmyyyy(app.tenancy_start),
      guaranteeExpiry: guaranteeExpiryLabel(app.tenancy_start),
      monthlyRent: rent,
      feeGBP,
      status: app.status,
      isPaid,
      isExpired,
      isClosed: app.status === "withdrawn",
      payable,
    };

    if (action === "view") {
      // Log the first view only (business-visible, partner-safe).
      if (!tok.first_viewed_at) {
        await service.from("payment_page_tokens").update({ first_viewed_at: new Date().toISOString() }).eq("token", token);
        await service.from("activity_log").insert({
          application_id: app.id, kind: "tenant_viewed_payment_page",
          message: "Tenant viewed the payment page.", actor: "Tenant", visibility: "business",
        });
      }
      return json({ ok: true, ...publicData });
    }

    if (action === "decline") {
      const reason = body.reason ? String(body.reason) : "other";
      const { data: result, error } = await service.rpc("decline_application_by_token", { p_token: token, p_reason: reason });
      if (error) return json({ ok: false, error: "Could not record that. Please contact hello@opndoor.co." }, 500);
      return json({ ok: true, status: result });
    }

    if (action === "checkout") {
      // Eligible to pay: Sent or Expired (paying reinstates), or a tenant-declined
      // withdrawal (money wins). Never a staff withdrawal, an already-paid app or a deed.
      if (!payable) {
        // Re-check the tenant-declined case which item 14 allows to reinstate.
        const { data: full } = await service.from("applications").select("withdrawn_by_tenant, status").eq("id", app.id).maybeSingle();
        const canReinstate = full?.status === "withdrawn" && full?.withdrawn_by_tenant === true;
        if (!canReinstate) return json({ ok: false, error: isPaid ? "This fee has already been paid." : "This application is closed.", status: app.status }, 409);
      }
      if (!STRIPE_SECRET.startsWith("sk_test_")) return json({ ok: false, error: "Payments are not configured for test mode." }, 400);
      const utm = typeof body.utm_source === "string" ? body.utm_source.slice(0, 40) : "confirmation_page";
      const stripe = new Stripe(STRIPE_SECRET, { httpClient: Stripe.createFetchHttpClient(), apiVersion: "2024-06-20" });
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "gbp",
            unit_amount: Math.round(rent * 100),
            product_data: { name: `Guarantor fee - ${app.guarantee_ref}`, description: "One month's rent, for the opndoor Deed of Guarantee." },
          },
          quantity: 1,
        }],
        metadata: { application_id: app.id, guarantee_ref: app.guarantee_ref, utm_source: utm },
        client_reference_id: app.id,
        success_url: `${APP_URL}/pay/confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/pay?token=${token}`,
      });
      await service.from("applications").update({
        stripe_checkout_session_id: session.id, payment_url: session.url, payment_state: "awaiting",
      }).eq("id", app.id);
      return json({ ok: true, url: session.url });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
