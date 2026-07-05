// =====================================================================
// payment-reminders (verify_jwt = false)
//
// The scheduled daily job that chases UNPAID guarantor fees (stuck-at-Sent
// applications). pg_cron -> net.http_post, twice at 07:00 and 08:00 UTC to cover
// BST/GMT; this function self-gates to 08:00 Europe/London so the off-hour run
// no-ops. It reminds the tenant at 2, 5 and 9 days after the application was Sent
// while still unpaid, exactly once per threshold (fire_payment_reminders is
// idempotent), reusing the branded payment email + existing Checkout link. Each
// reminder is a business activity entry (written by the RPC); send failures are
// logged internal (never a raw provider error to partners). Redirected to the
// review address in this test build.
//
// Auth: the cron path presents x-reminders-secret == REMINDERS_CRON_SECRET. The
// manual TEST path presents a signed-in opndoor-admin JWT and body {test:true}
// (optional {date:'YYYY-MM-DD'}) so the job can be verified without waiting.
//
// Background: this cron did not exist before (only deed-EXPIRY reminders and a
// manual resend), which is why the "8am payment reminder" never delivered.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { reminderEmailTemplate, sendEmail } from "./email.ts";
import { titleCaseAddress } from "../_shared/text.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-reminders-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function londonNow(): { hour: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { hour: Number(g("hour")), date: `${g("year")}-${g("month")}-${g("day")}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const CRON_SECRET = Deno.env.get("REMINDERS_CRON_SECRET") ?? "";

    const body = await req.json().catch(() => ({}));
    const test = !!body.test;
    const service = createClient(SUPABASE_URL, SERVICE);

    // Cron auth: the presented x-reminders-secret must match the edge env OR the
    // ops_secrets mirror (resilient to a drifted/unset edge env; the crons pass the
    // Vault secret, which the mirror holds).
    const presented = req.headers.get("x-reminders-secret") ?? "";
    let cronAuthed = Boolean(presented) && Boolean(CRON_SECRET) && presented === CRON_SECRET;
    if (!cronAuthed && presented) {
      const { data: sec } = await service.from("ops_secrets").select("secret").eq("name", "reminders_cron").maybeSingle();
      if (sec?.secret && presented === sec.secret) cronAuthed = true;
    }
    let adminAuthed = false;
    if (!cronAuthed) {
      const authHeader = req.headers.get("Authorization") ?? "";
      if (authHeader) {
        const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
        const { data: u } = await userClient.auth.getUser();
        if (u.user?.id) {
          const { data: prof } = await userClient.from("users").select("role").eq("id", u.user.id).maybeSingle();
          adminAuthed = prof?.role === "superadmin";
        }
      }
    }
    if (!cronAuthed && !adminAuthed) return json({ ok: false, error: "Not authorised." }, 401);
    if (!cronAuthed && !test) return json({ ok: false, error: "Manual runs must set { test: true }." }, 400);

    const nowL = londonNow();
    if (!test && nowL.hour !== 8) {
      return json({ ok: true, skipped: `not 08:00 Europe/London (currently ${String(nowL.hour).padStart(2, "0")}:00)` });
    }

    const pToday = (test && typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : nowL.date;

    // #13 Auto-expire unpaid Sent applications older than 14 days FIRST, so an
    // expired application is never also reminded. (fire_payment_reminders already
    // filters status='sent', so this only needs to run before it.)
    const { data: expiredCount } = await service.rpc("expire_stale_applications", { p_today: pToday });

    // Fire due reminders (idempotent). Returns only the NEW ones to email.
    const { data: fired, error: rpcErr } = await service.rpc("fire_payment_reminders", { p_today: pToday });
    if (rpcErr) return json({ ok: false, error: rpcErr.message }, 500);
    const due = (fired ?? []) as Array<{
      application_id: string; guarantee_ref: string; days: number;
      tenant_title: string | null; tenant_last_name: string | null; tenant_email: string | null;
      prop_addr1: string | null; prop_postcode: string | null; monthly_rent: number | null; payment_url: string | null;
    }>;

    const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
    let emailed = 0, emailFailed = 0;
    for (const r of due) {
      const rent = Number(r.monthly_rent ?? 0);
      // #1/#2 Point the reminder at the confirmation page with a per-touch utm_source.
      const { data: pageToken } = await service.rpc("mint_payment_page_token", { p_ref: r.guarantee_ref });
      const payUrl = pageToken && APP_URL ? `${APP_URL}/pay?token=${pageToken}&utm_source=reminder_${r.days}` : (r.payment_url ?? "");
      const tpl = reminderEmailTemplate({
        title: r.tenant_title ?? "",
        lastName: r.tenant_last_name ?? "",
        // #8 Title-case the address line for display; postcode left raw.
        propertyAddr: [titleCaseAddress(r.prop_addr1), r.prop_postcode].filter(Boolean).join(", "),
        guaranteeRef: r.guarantee_ref,
        amount: `£${rent.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`,
        payUrl,
        intendedFor: r.tenant_email ?? "the tenant",
        day: Number(r.days),
      });
      const res = await sendEmail({ subject: tpl.subject, html: tpl.html });
      if (res.ok) {
        emailed += 1;
      } else {
        emailFailed += 1;
        await service.from("activity_log").insert({
          application_id: r.application_id, kind: "payment_reminder_email_failed",
          message: `Payment reminder email not sent: ${res.error}`, actor: "System", visibility: "internal",
        });
      }
    }

    return json({ ok: true, test, date: pToday, expired: expiredCount ?? 0, due: due.length, emailed, emailFailed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unexpected error.";
    // #3 A total cron failure (a crash before it could log anything) still alerts
    // ops via report_ops_incident; deduped to one per hour in the database.
    try {
      const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await svc.rpc("report_ops_incident", { p_type: "cron_error:payment-reminders", p_detail: `payment-reminders: ${msg}` });
    } catch { /* never mask the original failure */ }
    return json({ ok: false, error: msg }, 500);
  }
});
