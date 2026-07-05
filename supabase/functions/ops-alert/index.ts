// =====================================================================
// ops-alert (verify_jwt = false)
//
// #3 Operational failure alerting. Called (fire-and-forget, via pg_net) by the
// activity_log failure trigger and by report_ops_incident for infra failures.
// It formats a branded ops email describing what failed, which application, the
// error and a deep link, and sends it to OPS_ALERT_ADDRESS (falling back to the
// test review address). Dedupe is handled in the database (ops_alerts): by the
// time we are called, at most one alert per failure type per application per hour
// has been recorded, so we simply send.
//
// Auth: the DB presents x-ops-secret, matched against REMINDERS_CRON_SECRET (edge
// env) OR the ops_secrets mirror (resilient to a drifted/unset edge env, exactly
// like the reminder crons). No other caller is accepted.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ops-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "opndoor <payments@opndoor.co>";
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "hello@opndoor.co";
// Production sets OPS_ALERT_ADDRESS; in this test build it falls back to the review address.
const OPS_ADDRESS = Deno.env.get("OPS_ALERT_ADDRESS") ?? Deno.env.get("EMAIL_REVIEW_ADDRESS") ?? "";
const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");

// Human-readable label per failure type (partner-safe wording is irrelevant here:
// this email only ever goes to the opndoor ops address).
const LABELS: Record<string, string> = {
  deed_error: "Deed generation failed",
  deed_delivery_failed: "Deed email to the agent failed to send",
  deed_reminder_failed: "Deed signature reminder failed to send",
  deed_undelivered: "Deed issued but not delivered (no agent contact)",
  expiry_reminder_email_failed: "Expiry reminder email failed to send",
  payment_reminder_email_failed: "Payment reminder email failed to send",
  payment_email_failed: "Payment email failed to send",
  refund_email_failed: "Refund confirmation email failed to send",
  refund_anomaly: "Refund policy anomaly (review required)",
  payment_anomaly: "Payment received on a withdrawn application (review + refund)",
  cron_error: "Scheduled job error",
  webhook_error: "Webhook processing error",
};

const VALHALLA = "#271d5f";
const DANGER = "#c0392b";
const INK_SOFT = "#5b4d86";
const LILAC = "#f8eff9";

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function row(label: string, value: string): string {
  return `<tr>
    <td style="padding:6px 0;font:600 12px 'Manrope',system-ui,Arial,sans-serif;color:${INK_SOFT};white-space:nowrap;vertical-align:top;">${label}</td>
    <td style="padding:6px 0 6px 16px;font:600 14px 'Manrope',system-ui,Arial,sans-serif;color:${VALHALLA};">${value}</td>
  </tr>`;
}

function template(p: { type: string; label: string; ref: string | null; tenant: string | null; partner: string | null; message: string; link: string | null }): { subject: string; html: string } {
  const subject = `[opndoor ops] ${p.label}${p.ref ? ` (${p.ref})` : ""}`;
  const rows = [
    row("Failure", esc(p.label)),
    row("Type", esc(p.type)),
    p.ref ? row("Application", esc(p.ref)) : "",
    p.tenant ? row("Tenant", esc(p.tenant)) : "",
    p.partner ? row("Partner", esc(p.partner)) : "",
  ].filter(Boolean).join("");
  const button = p.link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;"><tr><td>
        <a href="${p.link}" style="display:inline-block;background:${VALHALLA};color:#fff;text-decoration:none;font:700 14px 'Manrope',system-ui,Arial,sans-serif;padding:12px 24px;border-radius:999px;">Open the application</a>
      </td></tr></table>`
    : "";
  const inner = `
    <p style="margin:0 0 6px;font:800 16px 'Sora',system-ui,Arial,sans-serif;color:${DANGER};">Operational failure</p>
    <p style="margin:0 0 16px;">${esc(p.label)} was detected and logged. Details below.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;border:1px solid rgba(39,29,95,0.12);border-radius:12px;background:${LILAC};"><tr><td style="padding:14px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    </td></tr></table>
    <div style="margin:12px 0;padding:12px 14px;border-radius:10px;background:#fff5f5;border:1px solid rgba(192,57,43,0.25);font:400 13px/1.5 'Manrope',system-ui,Arial,sans-serif;color:${VALHALLA};"><b style="color:${DANGER};">Error</b><br>${esc(p.message).slice(0, 800)}</div>
    ${button}`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f3fa;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3fa;padding:28px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:92%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px -18px rgba(39,29,95,0.4);">
          <tr><td style="background:${VALHALLA};padding:20px 28px;">
            <span style="font:800 20px 'Sora',system-ui,Arial,sans-serif;letter-spacing:-0.04em;color:#fff;">opndoor</span>
            <span style="font:600 12px 'Manrope',system-ui,Arial,sans-serif;color:rgba(255,255,255,0.7);margin-left:10px;">Operations alert</span>
          </td></tr>
          <tr><td style="padding:26px 28px;font:400 15px/1.6 'Manrope',system-ui,Arial,sans-serif;color:${VALHALLA};">${inner}</td></tr>
          <tr><td style="padding:16px 28px;background:${LILAC};font:400 12px/1.5 'Manrope',system-ui,Arial,sans-serif;color:${INK_SOFT};">Automated alert from the Guarantee Referral Portal. Deduped to one per failure type per application per hour.</td></tr>
        </table>
      </td></tr>
    </table></body></html>`;
  return { subject, html };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const CRON_SECRET = Deno.env.get("REMINDERS_CRON_SECRET") ?? "";
    const service = createClient(SUPABASE_URL, SERVICE);

    // Auth: x-ops-secret must match the edge env OR the ops_secrets mirror.
    const presented = req.headers.get("x-ops-secret") ?? "";
    let authed = Boolean(presented) && Boolean(CRON_SECRET) && presented === CRON_SECRET;
    if (!authed && presented) {
      const { data: sec } = await service.from("ops_secrets").select("secret").eq("name", "reminders_cron").maybeSingle();
      if (sec?.secret && presented === sec.secret) authed = true;
    }
    if (!authed) return json({ ok: false, error: "Not authorised." }, 401);

    const body = await req.json().catch(() => ({}));
    const type = String(body.alert_type ?? "unknown");
    const message = String(body.message ?? "");
    const appId = body.application_id ? String(body.application_id) : null;

    if (!OPS_ADDRESS) return json({ ok: false, error: "No OPS_ALERT_ADDRESS/EMAIL_REVIEW_ADDRESS configured." }, 500);
    if (!RESEND_API_KEY) return json({ ok: false, error: "Resend not configured." }, 500);

    // Enrich with the application context (ref/tenant/partner) when present.
    let ref: string | null = null, tenant: string | null = null, partner: string | null = null;
    if (appId) {
      const { data: app } = await service
        .from("applications")
        .select("guarantee_ref, tenant_title, tenant_first_name, tenant_last_name, partner:partners(name)")
        .eq("id", appId)
        .maybeSingle();
      if (app) {
        ref = app.guarantee_ref ?? null;
        tenant = [app.tenant_title, app.tenant_first_name, app.tenant_last_name].filter((x) => (x ?? "").toString().trim()).join(" ") || null;
        // deno-lint-ignore no-explicit-any
        const p = app.partner as any;
        partner = (Array.isArray(p) ? p[0]?.name : p?.name) ?? null;
      }
    }
    const link = ref && APP_URL ? `${APP_URL}/applications/${encodeURIComponent(ref)}` : null;
    // Cron/webhook alert_types carry a source suffix (e.g. "cron_error:weekly-digest")
    // so distinct jobs dedupe separately; still render a clean human label.
    const label = LABELS[type]
      ?? (type.startsWith("cron_error") ? "Scheduled job error"
        : type.startsWith("webhook_error") ? "Webhook processing error"
        : type);
    const tpl = template({ type, label, ref, tenant, partner, message, link });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [OPS_ADDRESS], reply_to: REPLY_TO, subject: tpl.subject, html: tpl.html }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return json({ ok: false, error: `Resend responded ${res.status}: ${detail.slice(0, 200)}` }, 502);
    }
    return json({ ok: true, sent_to: OPS_ADDRESS, type, ref });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
