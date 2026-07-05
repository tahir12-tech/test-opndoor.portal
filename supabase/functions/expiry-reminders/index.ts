// =====================================================================
// expiry-reminders (verify_jwt = false)
//
// The scheduled daily job (pg_cron -> net.http_post, twice at 07:00 and 08:00
// UTC to cover BST/GMT; this function self-gates to 08:00 Europe/London and the
// off-hour run no-ops). For every in-force guarantee (Deed Issued, not refunded)
// it fires reminders at 30 / 14 / 7 days then daily inside the final 7, exactly
// once per threshold (fire_expiry_reminders is idempotent). Each new reminder is
// a business activity entry (written by the RPC) AND an email to the owning
// referrer + partner management via the branded Resend template (redirected to
// the review address in this build; failures logged internal, never raw to
// partners - they still get the in-app reminder).
//
// Auth: the cron path presents x-reminders-secret == REMINDERS_CRON_SECRET.
// The manual TEST path presents a signed-in opndoor-admin JWT and body {test:true}
// (optional {date, reset}) so the job can be verified today without waiting.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendEmail, expiryReminderTemplate } from "./email.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-reminders-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** Current hour and calendar date in Europe/London. */
function londonNow(): { hour: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { hour: Number(g("hour")), date: `${g("year")}-${g("month")}-${g("day")}` };
}
function addDaysStr(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function dmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
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
    const reset = !!body.reset;
    const service = createClient(SUPABASE_URL, SERVICE);

    // Auth: cron secret (edge env OR the ops_secrets mirror, resilient to a drifted
    // edge env), or a signed-in opndoor admin (test path).
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
    // Only opndoor admin may drive the manual/test path; cron runs the real job.
    if (!cronAuthed && !test) return json({ ok: false, error: "Manual runs must set { test: true }." }, 400);

    const nowL = londonNow();
    // Production gate: run only at 08:00 Europe/London (the other cron hour no-ops).
    if (!test && nowL.hour !== 8) {
      return json({ ok: true, skipped: `not 08:00 Europe/London (currently ${String(nowL.hour).padStart(2, "0")}:00)` });
    }

    const pToday = (test && typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : nowL.date;

    // Test convenience: clear the reminder history for the windowed guarantees so
    // the run can be repeated from scratch. Never available on the cron path.
    if (test && reset) {
      const { data: win } = await service.from("applications")
        .select("id").eq("status", "deed").gte("expiry_date", pToday).lte("expiry_date", addDaysStr(pToday, 30));
      const ids = (win ?? []).map((w: { id: string }) => w.id);
      if (ids.length) {
        await service.from("expiry_reminders").delete().in("application_id", ids);
        await service.from("applications").update({ expiry_reminders_sent: 0, last_expiry_reminder_at: null }).in("id", ids);
        // Also clear the prior reminder activity entries, so a repeated test run
        // starts genuinely from scratch (no duplicate partner-visible reminders).
        await service.from("activity_log").delete().in("application_id", ids).in("kind", ["expiry_reminder", "expiry_reminder_email_failed"]);
      }
    }

    // Fire due reminders (idempotent). Returns only the NEW ones to email.
    const { data: fired, error: rpcErr } = await service.rpc("fire_expiry_reminders", { p_today: pToday });
    if (rpcErr) return json({ ok: false, error: rpcErr.message }, 500);
    const newReminders = (fired ?? []) as Array<{
      application_id: string; guarantee_ref: string; days: number; expiry_date: string;
      agency: string | null; branch: string | null; referrer_email: string | null; partner_id: string; prop: string | null;
    }>;

    // Management recipients per partner (one query), for the "intended for" line.
    const { data: mgmt } = await service.from("users").select("email, partner_id").eq("role", "management");
    const mgmtByPartner = new Map<string, string[]>();
    for (const u of (mgmt ?? []) as Array<{ email: string; partner_id: string }>) {
      if (!u.email) continue;
      const list = mgmtByPartner.get(u.partner_id) ?? [];
      list.push(u.email);
      mgmtByPartner.set(u.partner_id, list);
    }

    let emailed = 0, emailFailed = 0;
    for (const r of newReminders) {
      const recipients = [r.referrer_email, ...(mgmtByPartner.get(r.partner_id) ?? [])].filter(Boolean) as string[];
      const tpl = expiryReminderTemplate({
        guaranteeRef: r.guarantee_ref, prop: r.prop ?? "", agency: r.agency ?? "", branch: r.branch ?? "",
        daysUntil: r.days, expiryDmy: dmy(r.expiry_date), intendedFor: recipients.join(", ") || "the owning referrer and partner management",
      });
      const res = await sendEmail({ subject: tpl.subject, html: tpl.html });
      if (res.ok) {
        emailed += 1;
      } else {
        emailFailed += 1;
        // Honest, admin-only detail; partners still have the business in-app reminder.
        await service.from("activity_log").insert({
          application_id: r.application_id, kind: "expiry_reminder_email_failed",
          message: `Expiry reminder email not sent: ${res.error}`, actor: "System", visibility: "internal",
        });
      }
    }

    return json({ ok: true, test, date: pToday, fired: newReminders.length, emailed, emailFailed });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
