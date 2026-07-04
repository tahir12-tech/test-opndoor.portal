// =====================================================================
// expiry-cohorts (verify_jwt = false)
//
// #86 The scheduled monthly job (pg_cron -> net.http_post, twice at 07:00 and
// 08:00 UTC to cover BST/GMT; this function self-gates to 08:00 Europe/London so
// the off-hour run no-ops). SIX WEEKS before a calendar month begins, it emails
// each partner's Management the cohort of guarantees expiring in that month,
// soonest first, as a CSV attachment. Already-expired guarantees are excluded.
// One email per (partner, month) via the expiry_cohort_sends ledger.
//
// Auth: the cron path presents x-reminders-secret == REMINDERS_CRON_SECRET. The
// manual TEST path presents a signed-in opndoor-admin JWT and body {test:true}
// (optional {month:'YYYY-MM'}) so it can be verified without waiting.
//
// Columns are kept identical to the on-demand buildExpiriesCsv (exportsService).
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-reminders-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "opndoor <payments@opndoor.co>";
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "hello@opndoor.co";
const REVIEW_ADDRESS = Deno.env.get("EMAIL_REVIEW_ADDRESS");

function londonNow(): { hour: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { hour: Number(g("hour")), date: `${g("year")}-${g("month")}-${g("day")}` };
}
function dmy(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso ?? "");
}
function gbp(n: number): string {
  return `£${(n ?? 0).toLocaleString("en-GB")}`;
}
function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows: (string | number)[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso + "T00:00:00Z").getTime();
  const b = new Date(bIso + "T00:00:00Z").getTime();
  return Math.round((a - b) / 86400000);
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

    const cronAuthed = Boolean(CRON_SECRET) && req.headers.get("x-reminders-secret") === CRON_SECRET;
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

    // The cohort month = the calendar month that BEGINS exactly 42 days from today
    // (six weeks before it starts). A test run may pass { month: 'YYYY-MM' }.
    let cohortMonth: string;
    if (test && typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month)) {
      cohortMonth = body.month;
    } else {
      const [y, m, d] = nowL.date.split("-").map(Number);
      const target = new Date(Date.UTC(y, m - 1, d + 42));
      if (target.getUTCDate() !== 1) {
        return json({ ok: true, skipped: `today + 42 days is not the 1st of a month (${target.toISOString().slice(0, 10)})` });
      }
      cohortMonth = target.toISOString().slice(0, 7);
    }

    const [cy, cm] = cohortMonth.split("-").map(Number);
    const monthStart = `${cohortMonth}-01`;
    const monthEnd = new Date(Date.UTC(cy, cm, 0)).toISOString().slice(0, 10); // last day of month
    const service = createClient(SUPABASE_URL, SERVICE);

    // All in-force guarantees expiring in the cohort month (any partner), with the
    // fields the export needs. Refunded and already-expired rows are dropped below.
    const { data: apps, error: appErr } = await service.from("applications")
      .select("id, guarantee_ref, tenancy_start, expiry_date, monthly_rent, payment_state, partner_id, tenant_first_name, tenant_last_name, prop_addr1, prop_addr2, prop_city, prop_postcode, branch:branches(name), agency:agencies(name), referrer:users!referrer_id(full_name)")
      .eq("status", "deed").gte("expiry_date", monthStart).lte("expiry_date", monthEnd);
    if (appErr) return json({ ok: false, error: appErr.message }, 500);

    // Management recipients per partner.
    const { data: mgmt } = await service.from("users").select("email, partner_id").eq("role", "management");
    const mgmtByPartner = new Map<string, string[]>();
    for (const u of (mgmt ?? []) as Array<{ email: string; partner_id: string }>) {
      if (!u.email || !u.partner_id) continue;
      const list = mgmtByPartner.get(u.partner_id) ?? [];
      list.push(u.email);
      mgmtByPartner.set(u.partner_id, list);
    }

    // Already-sent cohorts (idempotency).
    const { data: sent } = await service.from("expiry_cohort_sends").select("partner_id").eq("cohort_month", cohortMonth);
    const alreadySent = new Set((sent ?? []).map((s: { partner_id: string }) => s.partner_id));

    const COLS = ["Guarantee reference", "Tenant name", "Property address", "Agency", "Branch", "Tenancy start", "Expiry date", "Days remaining", "Monthly rent", "Annualised rent", "Referrer"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emb = (x: any) => (Array.isArray(x) ? x[0] : x);

    let sentCount = 0, skipped = 0, failed = 0;
    for (const [partnerId, recipients] of mgmtByPartner) {
      if (alreadySent.has(partnerId)) { skipped += 1; continue; }
      const cohort = (apps ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((a: any) => a.partner_id === partnerId && a.payment_state !== "refunded" && a.expiry_date && daysBetween(a.expiry_date, nowL.date) >= 0)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .sort((x: any, y: any) => (x.expiry_date < y.expiry_date ? -1 : x.expiry_date > y.expiry_date ? 1 : String(x.guarantee_ref).localeCompare(String(y.guarantee_ref))));
      if (!cohort.length) { skipped += 1; continue; }

      const rows: (string | number)[][] = [
        ["opndoor Guarantee Referral Portal - guarantees expiring"],
        ["Month", `${cohortMonth} (by guarantee expiry date, soonest first)`],
        ["Guarantees expiring", cohort.length],
        [],
        COLS,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...cohort.map((a: any) => {
          const addr = [a.prop_addr1, a.prop_addr2, a.prop_city, a.prop_postcode].filter(Boolean).join(", ");
          const tenant = [a.tenant_first_name, a.tenant_last_name].filter(Boolean).join(" ");
          return [a.guarantee_ref, tenant, addr, emb(a.agency)?.name ?? "", emb(a.branch)?.name ?? "",
            dmy(a.tenancy_start), dmy(a.expiry_date), String(daysBetween(a.expiry_date, nowL.date)),
            gbp(Number(a.monthly_rent)), gbp(Number(a.monthly_rent) * 12), emb(a.referrer)?.full_name ?? ""];
        }),
      ];
      const csv = toCSV(rows);
      const filename = `opndoor-expiries-${cohortMonth}.csv`;

      const dest = REVIEW_ADDRESS ? [REVIEW_ADDRESS] : recipients; // test build redirects to review
      const intended = recipients.join(", ");
      const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f3fa;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3fa;padding:28px 0;"><tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:92%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px -18px rgba(39,29,95,0.4);">
        <tr><td style="background:#271d5f;padding:22px 28px;"><span style="font:800 22px 'Sora',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:-0.04em;color:#fff;">opndoor</span><span style="font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:rgba(255,255,255,0.7);margin-left:10px;">Guarantee Referral Portal</span></td></tr>
        ${REVIEW_ADDRESS ? `<tr><td style="padding:10px 16px;background:#f8eff9;border-bottom:1px solid rgba(39,29,95,0.1);font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#5b4d86;">Test mode. This email was intended for ${intended} and redirected to you for review.</td></tr>` : ""}
        <tr><td style="padding:28px;font:400 15px/1.6 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#271d5f;">
          <p style="margin:0 0 14px;">Hello,</p>
          <p style="margin:0 0 14px;">Attached are the guarantees expiring in <b>${cohortMonth}</b> (${cohort.length}), soonest first, so you can arrange renewals or fresh referrals in good time. This cohort is sent six weeks before the month begins.</p>
          <p style="margin:0;font-size:13px;color:#5b4d86;">You can also download expiries for any month from your dashboard.</p>
        </td></tr>
        <tr><td style="padding:18px 28px;background:#f8eff9;font:400 12px/1.5 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#5b4d86;">opndoor. Questions? Reply to this email or contact ${REPLY_TO}.</td></tr>
        </table></td></tr></table></body></html>`;

      if (!RESEND_API_KEY || dest.length === 0) { failed += 1; continue; }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: EMAIL_FROM, to: dest, reply_to: REPLY_TO,
          subject: `Guarantees expiring in ${cohortMonth}`,
          html,
          attachments: [{ filename, content: btoa(unescape(encodeURIComponent(csv))) }],
        }),
      });
      if (!res.ok) { failed += 1; continue; }
      await service.from("expiry_cohort_sends").insert({ partner_id: partnerId, cohort_month: cohortMonth, recipients: recipients.length });
      sentCount += 1;
    }

    return json({ ok: true, test, cohortMonth, partnersEmailed: sentCount, skipped, failed });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
