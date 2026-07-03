// =====================================================================
// payment-confirmation (verify_jwt = false)
//
// Public, unauthenticated endpoint for the tenant's post-payment page. It is
// keyed to the Stripe Checkout **session id**, which is high-entropy and only
// ever handed to the tenant (via Stripe's success/cancel redirect). Given that
// capability it returns the MINIMAL confirmation state and nothing more:
//   - first name, guarantee reference, amount, whether the fee is paid,
//   - whether the Deed of Guarantee is ready to sign yet.
// It never returns the tenant's email, surname, address, phone or any other row
// data. On the explicit { action: "sign" } it mints a PandaDoc signing-session
// link (recipient-scoped by PandaDoc) and returns it, so the deep-link is only
// created on a real click, not on every poll.
//
// Abuse protection: the session id is unguessable (so enumeration is infeasible)
// AND every call is rate-limited via bump_rate_limit on two tiers - a coarse
// best-effort per-IP meter (all requests, incl. malformed) plus an authoritative
// per-session meter, with signing-link mints capped hardest. Unknown or malformed
// ids get a neutral { found: false } (no existence oracle).
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

// Minimal, self-contained PandaDoc signing-session minting (mirrors the shared
// helper) so this public function bundles as a single file.
const PANDADOC_API = "https://api.pandadoc.com/public/v1";
async function signingLink(documentId: string, recipientEmail: string): Promise<string | null> {
  const KEY = (Deno.env.get("PANDADOC_API_KEY") ?? "").trim();
  try {
    const res = await fetch(`${PANDADOC_API}/documents/${documentId}/session`, {
      method: "POST",
      headers: { Authorization: `API-Key ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: recipientEmail, lifetime: 60 * 60 * 24 * 7 }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.id ? `https://app.pandadoc.com/s/${j.id}` : null;
  } catch {
    return null;
  }
}

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
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const service = createClient(SUPABASE_URL, SERVICE);

    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const action = body.action === "sign" ? "sign" : "status";

    // Coarse per-IP meter on EVERY request (including malformed ones, before the
    // format check). Best-effort only: x-forwarded-for is client-forgeable, so we
    // take the RIGHTMOST hop (added by the trusted edge) and treat the per-session
    // limit below as the authoritative one.
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean).pop() || "noip";
    const { data: ipOk } = await service.rpc("bump_rate_limit", { p_key: `payconf:ip:${ip}`, p_limit: 300, p_window_secs: 60 });
    if (ipOk === false) return json({ error: "Too many requests, please slow down." }, 429);

    // Stripe Checkout session ids look like cs_test_... / cs_live_...
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId) || sessionId.length > 200) return json({ found: false });

    // Authoritative meter, keyed on the session id: not amplifiable without many
    // valid (unguessable) session ids, so it caps abuse even if the IP is forged.
    const { data: sessOk } = await service.rpc("bump_rate_limit", { p_key: `payconf:sess:${sessionId}`, p_limit: 100, p_window_secs: 60 });
    if (sessOk === false) return json({ error: "Too many requests, please slow down." }, 429);

    const { data: app } = await service
      .from("applications")
      .select("tenant_first_name, tenant_email, guarantee_ref, monthly_rent, paid_amount, payment_state, status, deed_state, pandadoc_document_id, payment_url")
      .eq("stripe_checkout_session_id", sessionId)
      .maybeSingle();
    if (!app) return json({ found: false });

    const paid = app.payment_state === "paid" || (!!app.status && app.status !== "sent");
    const amount = app.paid_amount != null ? Number(app.paid_amount) : Number(app.monthly_rent ?? 0);
    const deedReady = app.deed_state === "awaiting_tenant" && !!app.pandadoc_document_id;
    const deedSigned = app.deed_state === "executed";
    const deedError = app.deed_state === "error";

    // "Sign your deed now": mint the signing-session link on demand. Minting is
    // an external (PandaDoc) call that issues a live 7-day link, so it is capped
    // hard per session (10/hour) on top of the limits above, so a leaked session
    // id cannot mint unlimited signing links. The signing link itself is scoped
    // to the recipient by PandaDoc; possession of the session id is the bearer
    // capability by design (the tenant is unauthenticated).
    if (action === "sign") {
      if (!deedReady) return json({ found: true, deedReady: false });
      const { data: mintOk } = await service.rpc("bump_rate_limit", { p_key: `paysign:${sessionId}`, p_limit: 10, p_window_secs: 3600 });
      if (mintOk === false) return json({ error: "Too many attempts, please try again later." }, 429);
      const url = await signingLink(app.pandadoc_document_id as string, app.tenant_email as string);
      return json({ found: true, deedReady: true, signingUrl: url });
    }

    return json({
      found: true,
      firstName: app.tenant_first_name ?? "",
      reference: app.guarantee_ref,
      amount,
      paid,
      deedReady,
      deedSigned,
      deedError,
      // The tenant's own Stripe checkout link (not PII), returned only while the
      // fee is unpaid so the cancel/retry page can offer "Return to payment".
      ...(paid ? {} : { payUrl: app.payment_url ?? null }),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
