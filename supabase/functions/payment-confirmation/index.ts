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
// The signing-session minting lives in _shared/pandadoc.ts (getSigningLink):
// one implementation resolves both the key (with the sandbox _TEST fallback) and
// the recipient (redirected to match the document), so this path and the tenant
// status screen cannot drift apart again.
import { getSigningLink } from "../_shared/pandadoc.ts";

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
    const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
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
      .select("tenant_first_name, tenant_email, guarantee_ref, monthly_rent, fee_amount, paid_amount, payment_state, status, deed_state, pandadoc_document_id, payment_url, livemode")
      .eq("stripe_checkout_session_id", sessionId)
      .maybeSingle();
    if (!app) return json({ found: false });

    // WAS: app.payment_state === "paid" || (app.status && app.status !== "sent")
    //
    // The second arm is what made this wrong. It reads "any status other than
    // sent means paid", which is true of 'paid' and 'deed' and false of the two
    // that matter: a staff-WITHDRAWN application whose payment landed anyway
    // reported as paid, and so did an EXPIRED one. So the tenant was shown
    // "Payment received", the full fee, and a promise that their Deed of
    // Guarantee was on its way, for an application that will never produce one.
    //
    // payment_state is the column that actually records payment.
    // apply_stripe_payment deliberately does NOT set it on the withdrawn branch,
    // which is the whole point of that branch, so keying on it alone tells the
    // truth in every case.
    const paid = app.payment_state === "paid";

    // Only fall back when the application really is paid. On the withdrawn
    // branch paid_amount is never written, so the old fallback quoted the full
    // fee as "paid" for money that is sitting on a withdrawn row awaiting a
    // refund.
    //
    // And the fallback itself was monthly_rent, which is the rent, not the
    // price. Since three and five week bases landed, and since a joint tenant
    // pays a share, the rent can be a long way from what actually left their
    // card, and this figure is labelled "Amount paid" on the confirmation page.
    // fee_amount is what was charged; the rent stays as the last resort for rows
    // created before fee_amount existed, where it is the same number.
    const amount = app.paid_amount != null
      ? Number(app.paid_amount)
      : (paid ? Number(app.fee_amount ?? app.monthly_rent ?? 0) : 0);
    /* AND WHAT IS STILL OWED, which is a different question from what was paid.
       `amount` above means "amount paid" and is deliberately 0 when nothing has
       been, which is right on the confirmation page. /pay/retry renders the SAME
       field under the label "Amount due", and it is reached only when the tenant
       abandoned or cancelled checkout, so paid is false by definition there: a
       tenant who owes £692.31 was shown "Amount due £0" beside a Return to
       payment button. Two labels over one number, so now there are two numbers.

       null rather than 0 when we have neither figure, so the page can omit the
       row instead of asserting that nothing is due. The monthly_rent fall back is
       kept for rows created before fee_amount existed, where the two are equal. */
    const amountDue = app.fee_amount != null
      ? Number(app.fee_amount)
      : (app.monthly_rent != null ? Number(app.monthly_rent) : null);
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
      const { link, detail } = await getSigningLink(app.pandadoc_document_id as string, app.tenant_email as string, app.livemode === true);
      if (!link) console.log(JSON.stringify({ event: "paysign_session_failed", ref: app.guarantee_ref, detail: detail ?? null }));
      return json({ found: true, deedReady: true, signingUrl: link });
    }

    // "Return to payment" points at the durable /pay?token page, whose Pay button
    // mints a FRESH Stripe session on click, never the stored raw Stripe URL that
    // expires after 30 minutes. Null if the token cannot be minted, which the
    // retry page renders as "use the link in your email".
    let retryUrl: string | null = null;
    if (!paid && APP_URL) {
      const { data: token } = await service.rpc("mint_payment_page_token", { p_ref: app.guarantee_ref });
      retryUrl = token ? `${APP_URL}/pay?token=${token}&utm_source=retry` : null;
    }

    return json({
      found: true,
      firstName: app.tenant_first_name ?? "",
      reference: app.guarantee_ref,
      amount,
      // Only when there is something to owe: the retry page reads this and omits
      // the row entirely rather than printing £0 at somebody who owes money.
      ...(paid || amountDue == null ? {} : { amountDue }),
      paid,
      deedReady,
      deedSigned,
      deedError,
      ...(paid ? {} : { payUrl: retryUrl }),
    });
  } catch (e) {
    return json({ error: "The payment confirmation could not be completed." }, 500);
  }
});
