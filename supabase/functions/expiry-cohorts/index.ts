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
import { resolveRecipients } from "../_shared/emailRecipients.ts";

import { sendMessage } from "../_shared/mailer.ts";
import { timingSafeEqual } from "../_shared/partnerAuth.ts";

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
// const REVIEW_ADDRESS = Deno.env.get("EMAIL_REVIEW_ADDRESS");

function londonNow(): { hour: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { hour: Number(g("hour")), date: `${g("year")}-${g("month")}-${g("day")}` };
}
/* ONE DATE FORMAT, AND IT IS THE PORTAL'S. Matt, 2026-10-02: "dates as
   '20 Nov 2026' in the email body". The portal settled on that shape
   everywhere on screen (`formatDate`, "29 Sep 2026") and this document
   was still writing 20/11/2026, which is the one format that is read
   differently on two continents. Built from the parts, so no timezone
   can move the day. */
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dmy(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  return `${Number(m[3])} ${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}`;
}

/** "2026-11" -> "November 2026", for the subject and the opening line. */
const MONTH_LONG = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
function monthWords(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${MONTH_LONG[Number(m[2]) - 1]} ${m[1]}` : ym;
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
    const service = createClient(SUPABASE_URL, SERVICE);

    // Cron auth: the presented x-reminders-secret must match the edge env OR the
    // ops_secrets mirror (resilient to a drifted/unset edge env; the crons pass the
    // Vault secret, which the mirror holds).
    const presented = req.headers.get("x-reminders-secret") ?? "";
    // Constant time: a cron secret is a bearer credential, and `===` leaks a
    // matching prefix through timing the way a password compare does. The
    // helper already existed for the partner API and the webhook verifier.
    let cronAuthed = Boolean(presented) && Boolean(CRON_SECRET) && timingSafeEqual(presented, CRON_SECRET);
    if (!cronAuthed && presented) {
      const { data: sec } = await service.from("ops_secrets").select("secret").eq("name", "reminders_cron").maybeSingle();
      if (sec?.secret && timingSafeEqual(presented, sec.secret)) cronAuthed = true;
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

    // All in-force guarantees expiring in the cohort month (any partner), with the
    // fields the export needs. Refunded and already-expired rows are dropped below.
    const { data: apps, error: appErr } = await service.from("applications")
      .select("id, guarantee_ref, tenancy_start, expiry_date, monthly_rent, fee_amount, share_amount, tenancy_id, payment_state, partner_id, agency_id, tenant_first_name, tenant_last_name, prop_addr1, prop_addr2, prop_city, prop_postcode, branch:branches(name), agency:agencies(name), referrer:users!referrer_id(full_name)")
      // livemode: this list is emailed to each partner's management users as a
      // cohort export. A sandbox rehearsal that reached 'deed' would appear in a
      // real partner's expiring-guarantees report as a guarantee they believe is
      // in force. service_role bypasses the restrictive policy, so the filter has
      // to be here.
      .eq("status", "deed").eq("livemode", true).gte("expiry_date", monthStart).lte("expiry_date", monthEnd);
    if (appErr) return json({ ok: false, error: appErr.message }, 500);

    /* ONE READER, THE AGENCIES THEY COVER.
       This was `users where role='management'` bucketed by partner_id, with no
       status, position or agency filter. On the agency rail every agency
       shares the house partner, so each reader received every agency's
       cohort: a CSV of another agency's tenants, their addresses and their
       rents, monthly. staff_notification_scopes resolves the position each
       reader already holds, and returns one row per (reader, agency). */
    const partnerIds = [...new Set(((apps ?? []) as Array<{ partner_id: string }>).map((a) => a.partner_id))];
    type Reader = { userId: string; email: string; partnerId: string; agencyIds: Set<string> };
    const readers = new Map<string, Reader>();
    for (const pid of partnerIds) {
      const { data: scopes } = await service.rpc("staff_notification_scopes", { p_partner: pid });
      for (const row of (scopes ?? []) as Array<{ user_id: string; email: string; agency_id: string }>) {
        if (!row.email) continue;
        const r = readers.get(row.user_id) ?? { userId: row.user_id, email: row.email, partnerId: pid, agencyIds: new Set<string>() };
        r.agencyIds.add(row.agency_id);
        readers.set(row.user_id, r);
      }
    }

    // Already-sent cohorts (idempotency), now per reader: the ledger gained a
    // user_id in 20261006200000, because a partner-level row would mark the
    // whole partner done on the first reader's send.
    /* A TEST RUN DOES NOT TOUCH THE REAL LEDGER, in either direction.

       It used to write to it. The ledger is what makes the real 08:00 send
       idempotent, so one admin pressing the test button marked that reader's
       cohort as already sent, and the real run then skipped it: a month of
       expiring guarantees that nobody was told about, reported as a clean
       `skipped` on a job whose Health row stayed green. The cohort CSV is the
       renewal pipeline, so that is a silent commercial loss, not a cosmetic
       one.

       Reading it is dropped too, so a test always exercises the whole path
       rather than skipping whatever the last real run covered. Test sends are
       routed to the review address by resolveRecipients, so re-sending on a
       repeated test costs nothing. */
    const { data: sent } = test
      ? { data: [] as Array<{ partner_id: string; user_id: string | null }> }
      : await service.from("expiry_cohort_sends").select("partner_id, user_id").eq("cohort_month", cohortMonth);
    const alreadySent = new Set((sent ?? []).map((s: { partner_id: string; user_id: string | null }) => s.user_id ?? s.partner_id));

    /* THE SAME COLUMNS AS THE ADMIN EXPIRIES FILE, which is the whole
       instruction: Matt, 2026-10-02, "bring the agency-facing
       'guarantees expiring' monthly email and its spreadsheet into line
       with the admin Expiries export". Until now the two documents
       about one subject disagreed about what the subject was -- this
       one had no fee at all, said "Annualised rent" without saying
       whose, and had no way to show that a row has siblings.

       AND NO OPNDOOR-INTERNAL COLUMNS, which is the other half of it.
       The admin file's set happens to contain none: there is no
       commission on it, and Agency and Branch are the reader's own. So
       the two are the same list rather than a subset, and the next
       column added to one has to be thought about for the other. */
    const COLS = ["Guarantee reference", "Tenant name", "Tenants on the guarantee", "Joint with",
      "Property address", "Agency", "Branch", "Tenancy start", "Expiry date", "Days remaining",
      "Monthly rent (whole tenancy)", "Annualised rent (this tenant's share)",
      "Guarantee fee (whole tenancy)", "Referrer"];

    /* THE TENANCIES, FROM THE WHOLE BOOK AND NOT FROM THIS MONTH'S SET.
       "Joint with" names the other tenants on a tenancy, and a joint
       tenant whose own guarantee expires in a different month is not in
       `apps` and is still their joint tenant. The admin file reads the
       whole book for the same reason. One query for every tenancy in
       play rather than one per row. */
    const tenancyIds = [...new Set((apps ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((a: any) => a.tenancy_id).filter(Boolean))] as string[];
    const siblings = new Map<string, { ref: string; fee: number }[]>();
    if (tenancyIds.length) {
      const { data: sibRows } = await service.from("applications")
        .select("guarantee_ref, tenancy_id, fee_amount, monthly_rent")
        .in("tenancy_id", tenancyIds);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (sibRows ?? []) as any[]) {
        const list = siblings.get(r.tenancy_id) ?? [];
        list.push({ ref: r.guarantee_ref, fee: Number(r.fee_amount ?? r.monthly_rent ?? 0) });
        siblings.set(r.tenancy_id, list);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emb = (x: any) => (Array.isArray(x) ? x[0] : x);

    let sentCount = 0, skipped = 0, failed = 0;
    for (const reader of readers.values()) {
      const partnerId = reader.partnerId;
      const recipients = [reader.email];
      if (alreadySent.has(reader.userId)) { skipped += 1; continue; }
      const cohort = (apps ?? [])
        // NOT `a.partner_id === partnerId`. The agency is the boundary: a row
        // belongs in this reader's CSV only if they cover its agency.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        /* AGENCY-RAIL BUSINESS ONLY, the same rule agency_weekly_digest now
           applies. A direct application keeps partner_id = 'opndoor-direct'
           and is given an agency_id and branch_id by the automatic matcher,
           so it is invisible to that agency in the portal and was shipped to
           them every month in a CSV of tenant names, addresses and rents. A
           direct tenant is Opndoor's business, never the matched agency's. */
        .filter((a: any) => reader.agencyIds.has(a.agency_id)
          && a.partner_id === reader.partnerId
          && a.payment_state !== "refunded" && a.expiry_date && daysBetween(a.expiry_date, nowL.date) >= 0)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .sort((x: any, y: any) => (x.expiry_date < y.expiry_date ? -1 : x.expiry_date > y.expiry_date ? 1 : String(x.guarantee_ref).localeCompare(String(y.guarantee_ref))));
      if (!cohort.length) { skipped += 1; continue; }

      const rows: (string | number)[][] = [
        ["opndoor Guarantee Referral Portal - guarantees expiring"],
        ["Month", `${monthWords(cohortMonth)} (by guarantee expiry date, soonest first)`],
        ["Guarantees expiring", cohort.length],
        [],
        COLS,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...cohort.map((a: any) => {
          const addr = [a.prop_addr1, a.prop_addr2, a.prop_city, a.prop_postcode].filter(Boolean).join(", ");
          const tenant = [a.tenant_first_name, a.tenant_last_name].filter(Boolean).join(" ");
          const mates = a.tenancy_id ? (siblings.get(a.tenancy_id) ?? []) : [];
          const others = mates.filter((m) => m.ref !== a.guarantee_ref).map((m) => m.ref).sort();
          /* THE TENANCY'S FEE, summed across its tenants, because the
             column says "whole tenancy" and a joint tenancy is priced
             once and charged by share. A sole tenant's own fee IS the
             tenancy's. */
          const tenancyFee = mates.length
            ? mates.reduce((t, m) => t + m.fee, 0)
            : Number(a.fee_amount ?? a.monthly_rent ?? 0);
          /* AND THE ANNUALISED FIGURE IS THIS TENANT'S SHARE, which is
             what the admin file's heading now says out loud: a joint
             tenant guarantees their share of the rent, not all of it. */
          const share = Number(a.share_amount ?? a.monthly_rent ?? 0);
          return [a.guarantee_ref, tenant, String(mates.length || 1), others.join(", "),
            addr, emb(a.agency)?.name ?? "", emb(a.branch)?.name ?? "",
            dmy(a.tenancy_start), dmy(a.expiry_date), String(daysBetween(a.expiry_date, nowL.date)),
            gbp(Number(a.monthly_rent)), gbp(share * 12), gbp(tenancyFee),
            emb(a.referrer)?.full_name ?? ""];
        }),
      ];
      const csv = toCSV(rows);
      const filename = `opndoor-expiries-${cohortMonth}.csv`;

      // This one attaches a base64 CSV of tenant records, so an unintended
      // recipient here is a data-protection incident rather than a stray email.
      const routed = resolveRecipients(recipients);
      const dest = routed.to;
      const intended = routed.intended.join(", ");
      if (!RESEND_API_KEY || dest.length === 0) { failed += 1; continue; }
      // Attachments already worked here, and only here. The shared sender now
      // carries them for everybody.
      const res = await sendMessage({
        to: dest,
        message: {
          subject: `Guarantees expiring in ${monthWords(cohortMonth)}`,
          heading: `Guarantees expiring in ${monthWords(cohortMonth)}`,
          blocks: [
            // "November 2026", not "2026-11": the body is prose, and a
            // reader should not have to parse a sort key out of it.
            { p: `Attached are the guarantees expiring in <b>${monthWords(cohortMonth)}</b> (${cohort.length}), soonest first, so you can arrange renewals or fresh referrals in good time.` },
            /* THE SOONEST FEW, IN THE BODY. The attachment is the
               document; a person reading on a phone should not have to
               open it to learn whether anything is urgent. Dates in the
               portal's one format. */
            { rows: cohort.slice(0, 3).map((a: { guarantee_ref: string; expiry_date: string }) =>
                [a.guarantee_ref, dmy(a.expiry_date)] as [string, string]) },
            { small: "This cohort is sent six weeks before the month begins. You can also download expiries for any month from your dashboard." },
          ],
        },
        attachments: [{ filename, content: btoa(unescape(encodeURIComponent(csv))) }],
      });
      if (!res.ok) { failed += 1; continue; }
      if (!test) {
        await service.from("expiry_cohort_sends").insert({ partner_id: partnerId, user_id: reader.userId, cohort_month: cohortMonth, recipients: recipients.length });
      }
      sentCount += 1;
    }

    return json({ ok: true, test, cohortMonth, partnersEmailed: sentCount, skipped, failed, ledgerWritten: !test });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unexpected error.";
    // #3 A total cron failure (a crash before it could log anything) still alerts
    // ops via report_ops_incident; deduped to one per hour in the database.
    try {
      const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await svc.rpc("report_ops_incident", { p_type: "cron_error:expiry-cohorts", p_detail: `expiry-cohorts: ${msg}` });
    } catch { /* never mask the original failure */ }
    return json({ ok: false, error: "The expiry cohort could not be completed." }, 500);
  }
});
