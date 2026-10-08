// =====================================================================
// hubspot-sync  (verify_jwt = false)
//
// Portal -> HubSpot, one-way, event-driven. Consumes public.activity_log since
// a cursor, translates each lifecycle event through the CONFIG mapping tables
// (hubspot_sync_env / hubspot_field_map / hubspot_partner_map), and upserts
// Applicants + Companies + associations via the HubSpot v3/v4 CRM APIs. See
// HUBSPOT-SYNC-SPEC.md. Nothing here hard-codes a HubSpot object/pipeline/stage/
// association id — the active (sandbox) / dormant (production) blocks live in
// hubspot_sync_env; promotion is a config swap.
//
// Guardrails baked in:
//   §5 never-touch  — sync writes ONLY its own columns; a defensive filter drops
//                     calculation/owner/attribution/finance fields if they ever
//                     appear in a payload.
//   §8 no Contacts  — the ONLY object types this function ever writes are the
//                     Applicant custom object and companies. There is no code
//                     path to the contacts object; tenants never become Contacts.
//   §9 no backfill  — the cursor is initialised at go-live; pre-existing debris
//                     is never in range.
//   Idempotency     — every action keys on (event id, target) in
//                     hubspot_sync_events; and every HubSpot write is idempotent
//                     by construction (upsert on a unique property; PUT assoc).
//   Failures        — reported through the existing ops-alert channel via
//                     report_ops_incident('hubspot_sync_error:<partner>', …).
//                     The suffix is not decoration: ops_alerts dedupes on
//                     (alert_type, coalesce(application_id,zero), hour_bucket)
//                     and this function always passes a null application_id, so
//                     a bare type let the FIRST partner to fail in an hour hide
//                     every other partner's failure for the rest of it. Same
//                     convention as 'cron_error:<jobname>'.
//                     The cursor holds at the last success so the batch retries;
//                     and because a retry that can never succeed is a queue that
//                     never drains, a repeatedly failing event is PARKED after
//                     MAX_ATTEMPTS and PARK_AFTER_MS (see the catch) and the
//                     partner's queue moves past it.
//   Config gaps     — a missing hubspot_partner_map row, a partner company that
//                     does not exist in the Hub, an unset association type id:
//                     these are config, not data, and they used to THROW, which
//                     froze that partner's whole feed permanently. They now gate
//                     the affected edge exactly as the §6 org gate does (warn,
//                     alert, leave the ledger unrecorded so a later event
//                     completes it) and the queue keeps draining.
//
// Auth (manual/cron trigger): x-ops-secret matched against REMINDERS_CRON_SECRET
// (edge env) OR the ops_secrets 'reminders_cron' mirror — the same shape as
// ops-alert / the reminder crons. The sandbox smoke invokes it exactly like a
// cron would: via pg_net, with the secret read from ops_secrets inside SQL.
// HubSpot token resolution: HUBSPOT_ACCESS_TOKEN (edge env, set on the project)
// -> x-hubspot-token header -> ops_secrets 'hubspot_access_token'.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { maySyncToHubspot } from "../_shared/livemodeCredentials.ts";
import { timingSafeEqual } from "../_shared/partnerAuth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ops-secret, x-hubspot-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const HS_BASE = "https://api.hubapi.com";
const COMPANIES = "companies";

// activity_log.kind -> internal sync event (§4). deed_issued kept as an alias of
// deed_signed (both mean "deed executed" in the portal; the action is idempotent).
const KIND_TO_EVENT: Record<string, string> = {
  referral_created: "referral",
  payment_received: "fee_paid",
  deed_signed: "deed_issued",
  deed_issued: "deed_issued",
  deed_delivered: "delivered",
  refunded: "refund",
  withdrawn: "withdrawn",
  tenancy_amended: "tenancy_amend",
};

// §5 never-touch (HubSpot-owned). Defensive: config never maps these, but if one
// ever slips into a payload we drop it rather than trample HubSpot's work.
const NEVER_TOUCH = new Set([
  "commission_owed", "guarantee_expiry", "attribution_status", "commission_paid",
  "hubspot_owner_id", "hubspot_owner_assigneddate", "hubspot_team_id",
]);

// ---- poison-queue limits ----------------------------------------------
// The cron fires every two minutes. An event that has failed MAX_ATTEMPTS times
// AND has been failing for longer than PARK_AFTER_MS is parked: recorded in the
// ledger as a dead letter, the cursor advanced past it, the rest of that
// partner's queue drained. Both conditions, not either: the count alone would
// park real events during a twenty minute HubSpot outage, and the clock alone
// would park an event the very first time it failed after a quiet spell.
//
// Half an hour is the number because it is longer than any HubSpot incident we
// have seen and far shorter than the weeks a permanently poisoned queue has
// historically sat unnoticed. A parked event is NOT discarded: its ledger rows
// name it for replay (see README), and parking raises its own alert type so it
// cannot hide behind the ordinary error's hourly dedupe.
const MAX_ATTEMPTS = 8;
const PARK_AFTER_MS = 30 * 60 * 1000;
const FAILED = "failed";        // ledger target for one failed attempt
const DEAD_LETTER = "dead_letter"; // ledger target for a parked event

// ---- value transforms -------------------------------------------------
const dateOnly = (v: unknown) => String(v).slice(0, 10);                       // YYYY-MM-DD
const midnightMs = (v: unknown) => String(Date.parse(dateOnly(v) + "T00:00:00Z")); // HubSpot date-picker datetime wants midnight UTC
function transformValue(v: unknown, t: string | null): string | null {
  if (v === null || v === undefined || v === "") return null;
  switch (t) {
    case "number": return String(v);
    case "date": return dateOnly(v);
    case "datetime": return midnightMs(v);
    default: return String(v);
  }
}

type FieldRow = { object: string; hs_property: string; source_kind: string; source: string; transform: string | null; events: string[] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const started = Date.now();
  // Best effort, never throws, never masks the caller's own error. Every exit
  // below that means "this function cannot work at all" goes through it first:
  // a bare 500 is recorded only as a non-2xx in net._http_response, which
  // nobody reads until they already suspect a problem, and the whole point of
  // these faults is that nobody suspects. Declared out here, with a no-op
  // default, so the outer catch can use it even if the client never got built.
  let incident = async (_type: string, _detail: string) => {};
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const CRON_SECRET = Deno.env.get("REMINDERS_CRON_SECRET") ?? "";
    const service = createClient(SUPABASE_URL, SERVICE);

    incident = async (type: string, detail: string) => {
      try { await service.rpc("report_ops_incident", { p_type: type, p_detail: detail }); } catch { /* ignore */ }
    };

    // ---- auth (x-ops-secret vs edge env OR ops_secrets mirror) --------
    const presented = req.headers.get("x-ops-secret") ?? "";
    // Constant time: a cron secret is a bearer credential, and `===` leaks a
    // matching prefix through timing the way a password compare does. The
    // helper already existed for the partner API and the webhook verifier.
    let authed = Boolean(presented) && Boolean(CRON_SECRET) && timingSafeEqual(presented, CRON_SECRET);
    if (!authed && presented) {
      const { data: sec } = await service.from("ops_secrets").select("secret").eq("name", "reminders_cron").maybeSingle();
      if (sec?.secret && timingSafeEqual(presented, sec.secret)) authed = true;
    }
    // Deliberately silent, unlike every other failure exit below. verify_jwt is
    // false on this function, so anything on the internet can reach it and a
    // 401 is the expected answer to a probe; alerting here would hand a
    // stranger the ops inbox. A cron whose secret is wrong shows up instead as
    // the partner feed going quiet, which hubspot_stale_partners is for.
    if (!authed) return json({ ok: false, error: "Not authorised." }, 401);

    // ---- HubSpot token ------------------------------------------------
    /* THE TOKEN IS OURS, SO IT COMES FROM US. This used to fall back to
       `req.headers.get("x-hubspot-token")` between the two real sources.
       The cron secret gates the function, so it was never open to the
       internet; what it meant is that anybody holding that one shared secret
       could choose WHICH HubSpot account our partner data was written into,
       by presenting their own token for us to authenticate with. A credential
       supplied by the caller is the caller's. Round 5, M13. */
    let TOKEN = Deno.env.get("HUBSPOT_ACCESS_TOKEN") ?? "";
    if (!TOKEN) {
      const { data: sec } = await service.from("ops_secrets").select("secret").eq("name", "hubspot_access_token").maybeSingle();
      TOKEN = sec?.secret ?? "";
    }
    if (!TOKEN) {
      // A missing token stops EVERY partner, and it is the failure most likely
      // to arrive by surprise: a rotated or expired HubSpot token, or a
      // redeploy that dropped the edge env var. Say so out loud.
      /* DELIBERATELY OFF IS NOT BROKEN. On an environment with no HubSpot --
         dev, a clone, a rehearsal -- a missing token is the intended state,
         and alerting on it every two minutes trains whoever reads the alerts
         to skip that line. The environment says so explicitly through
         ops_secrets 'hubspot_disabled'; nothing is inferred from the project
         ref or the hostname, because an environment that can be guessed wrong
         is one that will be. Production has no such row, so there a missing
         token still alerts exactly as before. */
      const { data: off } = await service.rpc("ops_hubspot_disabled");
      if (off === true) {
        /* DISABLED IS A RECOVERY, not a silence. Somebody turning HubSpot
           off on this environment has resolved the "no token" alert, and
           leaving the latch set would mean a token going missing LATER --
           after it was turned back on -- said nothing, because the latch
           would still be holding the last episode. 20261007740000. */
        await service.rpc("clear_ops_incident", { p_type: "hubspot_sync_error:config" })
          .then(() => {}, () => {});
        return json({ ok: true, skipped: "disabled", detail: "HubSpot is disabled on this environment." });
      }
      await incident("hubspot_sync_error:config",
        "hubspot-sync: no HubSpot access token (HUBSPOT_ACCESS_TOKEN edge env, x-hubspot-token header, or ops_secrets 'hubspot_access_token'). Nothing is syncing.");
      return json({ ok: false, error: "No HubSpot access token configured." }, 500);
    }

    /* THE TOKEN IS THERE, SO THE CONFIG ALERT HAS RECOVERED. Matt's rule
       is "once, then not again until it changes or recovers", and this is
       the recovery: without it a token that went missing, was restored and
       went missing again would alert only the first time. 20261007740000. */
    await service.rpc("clear_ops_incident", { p_type: "hubspot_sync_error:config" })
      .then(() => {}, () => {});

    const hs = async (path: string, method = "GET", body?: unknown) => {
      const res = await fetch(`${HS_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HubSpot ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
      return text ? JSON.parse(text) : {};
    };

    // ---- load config --------------------------------------------------
    const { data: env, error: envErr } = await service.from("hubspot_sync_env").select("*").eq("is_active", true).maybeSingle();
    if (envErr || !env) {
      await incident("hubspot_sync_error:config",
        `hubspot-sync: no active row in hubspot_sync_env${envErr ? ` (${envErr.message})` : ""}. Nothing is syncing.`);
      return json({ ok: false, error: "No active HubSpot environment configured." }, 500);
    }
    const OBJ = env.applicant_object_type as string;
    const APP_BASE = (Deno.env.get("APP_URL") ?? env.app_base_url ?? "").replace(/\/$/, "");

    const { data: fmapRaw } = await service.from("hubspot_field_map").select("*").eq("active", true);
    const fmap = (fmapRaw ?? []) as FieldRow[];
    const applicantRows = fmap.filter((r) => r.object === "applicant");
    const companyNameFor = (logical: string) =>
      fmap.find((r) => r.object === "company" && r.source === logical)?.hs_property ?? null;
    // applicant property that references the associated (branch) company key (§3)
    const AREF_PROP = applicantRows.find((r) => r.source_kind === "derived" && r.source === "agency_ref")?.hs_property ?? null;

    const { data: pmapRaw } = await service.from("hubspot_partner_map").select("*").eq("active", true);
    const partnerMap = new Map((pmapRaw ?? []).map((p: any) => [p.partner_id, p]));

    // ---- cursors, ONE PER PARTNER -------------------------------------
    //
    // This used to be a singleton row, which made the whole sync a single queue:
    // the loop below breaks on the first error and holds the cursor, so ONE
    // poisoned event stopped EVERY partner's CRM updates until a human noticed.
    // With one live partner that was survivable. With a direct rail and a LIB
    // rail writing into the same activity_log it is not: a direct-signup event
    // that throws would freeze the referral partner's feed, silently.
    //
    // Draining oldest-cursor-first (the RPC orders by last_at) means a partner
    // that is behind is served before one that is current, so a stuck partner
    // cannot be starved by chatty ones once it recovers.
    const { data: partnerCursors, error: pcErr } = await service.rpc("hubspot_sync_partners");
    if (pcErr) {
      // The exact shape of a migration applied ahead of this deploy: the RPC
      // this bundle calls no longer resolves. It is silent by construction
      // (the function answers, with a 500 nobody reads), so it alerts here.
      await incident("hubspot_sync_error:config", `hubspot-sync: hubspot_sync_partners() failed: ${pcErr.message}. Nothing is syncing.`);
      return json({ ok: false, error: `cursors: ${pcErr.message}` }, 500);
    }
    if (!partnerCursors?.length) {
      await incident("hubspot_sync_error:config",
        "hubspot-sync: hubspot_sync_cursor_partner is empty, so no partner is being drained. Nothing is syncing.");
      return json({ ok: false, error: "No partner cursors initialised." }, 500);
    }

    const summaryWarn: string[] = [];
    const body = await req.json().catch(() => ({}));

    // ---- map verification ---------------------------------------------------
    //
    // WHY THIS EXISTS. HubSpot's batch upsert accepts a write to a property that
    // does not exist by IGNORING IT and returning success. So renaming or
    // deleting a property in the Hub does not break the sync: it makes the sync
    // silently stop recording that field, with nothing in the response, the
    // logs, cron_health or the portal saying so. It is found weeks later by
    // somebody asking why a report is empty, and by then the gap has no floor.
    //
    // The mapping is config in hubspot_field_map, and HubSpot will tell us what
    // actually exists, so the drift is directly checkable rather than something
    // to be discovered. One call per object type.
    //
    // Deliberately a separate action rather than part of every sync run: it is
    // two extra API calls and the answer changes only when somebody edits the
    // Hub, so running it hourly would spend quota to learn nothing.
    if (body?.action === "verify_map") {
      const { data: mapped } = await service
        .from("hubspot_field_map")
        .select("object, hs_property")
        .eq("active", true);

      const byObject = new Map<string, string[]>();
      for (const row of (mapped ?? []) as { object: string; hs_property: string }[]) {
        const objectType = row.object === "company" ? COMPANIES : OBJ;
        byObject.set(objectType, [...(byObject.get(objectType) ?? []), row.hs_property]);
      }

      const missing: { object: string; property: string }[] = [];
      const checked: string[] = [];

      for (const [objectType, props] of byObject) {
        const res = await hs(`/crm/v3/properties/${objectType}`);
        // A failure to READ the property list is not evidence that a property is
        // missing. Report it as unchecked rather than reporting every mapped
        // property as absent, which would be a false alarm at the worst scale.
        if (!res?.results) {
          summaryWarn.push(`could not read the property list for ${objectType}; not checked`);
          continue;
        }
        const exists = new Set((res.results as { name: string }[]).map((p) => p.name));
        checked.push(objectType);
        for (const prop of props) if (!exists.has(prop)) missing.push({ object: objectType, property: prop });
      }

      if (missing.length) {
        /* THROUGH report_ops_incident: ops_alerts.hour_bucket is NOT NULL with no
           default, so this direct insert failed on every call and the
           .then(noop, noop) swallowed it. Which is the worst one of the three to
           lose, because the condition it reports is itself silent: HubSpot
           ACCEPTS writes to properties that do not exist and discards them, so
           without this alert a drifted mapping looks exactly like a working sync.
           The RPC fills hour_bucket, dedups hourly and sends the ops email. */
        await service.rpc("report_ops_incident", {
          p_type: "hubspot_map_drift",
          p_detail:
            `${missing.length} mapped HubSpot propert${missing.length === 1 ? "y does" : "ies do"} not exist: `
            + missing.map((m) => `${m.object}.${m.property}`).join(", ")
            + `. Writes to ${missing.length === 1 ? "it are" : "them are"} being accepted and discarded.`,
        }).then(() => {}, () => {});
      }

      return json({
        ok: missing.length === 0,
        checked,
        mapped_count: (mapped ?? []).length,
        missing,
        warnings: summaryWarn,
      });
    }

    const LIMIT = Number(body?.limit ?? 200);

    const summary: any = {
      ok: true, env: env.env, refused_sandbox: summaryWarn, processed: 0, by: {},
      warnings: [], errors: [], partners: [] as any[],
      // Surfaced in the response body, not just in an alert, so the run itself
      // answers "is anything being skipped" without a database round trip.
      config_gaps: [] as string[], parked: [] as any[],
    };

    // One alert per distinct config gap per run. Without this a single missing
    // hubspot_partner_map row would call report_ops_incident once per event in
    // the batch; the hourly dedupe in SQL would absorb them, but the wasted
    // round trips are real and the intent should be visible here.
    const gapsSeen = new Set<string>();
    const configGap = async (what: string) => {
      summary.warnings.push(what);
      if (gapsSeen.has(what)) return;
      gapsSeen.add(what);
      summary.config_gaps.push(what);
      await incident("hubspot_sync_error:config", `hubspot-sync config gap: ${what}`);
    };

    // ---- idempotency ledger: check BEFORE, record AFTER success -------
    // Ledger id is the full key. Two families:
    //   `${event_id}:applicant`          — per-event applicant property upsert
    //   `assoc:${app_id}:partner|branch` — per-APPLICATION association state, so a
    //                                      branch confirmed AFTER the referral is
    //                                      completed on a later event, never lost.
    // Recording only after the action means a mid-action failure leaves no row, so
    // the retry re-runs it (every HubSpot write here is idempotent → redo is safe).
    const applied = async (id: string) =>
      Boolean((await service.from("hubspot_sync_events").select("id").eq("id", id).maybeSingle()).data);
    const write = async (id: string, eventId: string, target: string, appId: string | null) => {
      const { error } = await service.from("hubspot_sync_events").upsert(
        { id, event_id: eventId, target, application_id: appId }, { onConflict: "id", ignoreDuplicates: true });
      return error?.message ?? null;
    };
    // A ledger write that fails is not cosmetic: `applied` would keep saying no,
    // so every later run would redo the HubSpot write (harmless, it is
    // idempotent) and the association state would never settle (not harmless,
    // it is silent and permanent). supabase-js returns the error rather than
    // throwing it, so the old unchecked `await` discarded it. Raise it into the
    // per-event catch, which knows how to alert and how to give up.
    const record = async (id: string, eventId: string, target: string, appId: string | null) => {
      const err = await write(id, eventId, target, appId);
      if (err) throw new Error(`ledger write ${id}: ${err}`);
    };
    // The same write from inside the catch, where throwing again would escape
    // the per-event handler and abandon every remaining partner.
    const recordSoft = async (id: string, eventId: string, target: string, appId: string | null) => {
      const err = await write(id, eventId, target, appId);
      if (err) summary.warnings.push(`ledger write ${id} failed: ${err}`);
      return err === null;
    };

    // ---- HubSpot primitives ------------------------------------------
    const upsertApplicant = (gref: string, properties: Record<string, string>) =>
      hs(`/crm/v3/objects/${OBJ}/batch/upsert`, "POST", { inputs: [{ idProperty: "applicant_id", id: gref, properties }] })
        .then((r) => r.results[0].id as string);
    const upsertCompany = (key: string, properties: Record<string, string>) =>
      hs(`/crm/v3/objects/${COMPANIES}/batch/upsert`, "POST", { inputs: [{ idProperty: "crm_company_key", id: key, properties }] })
        .then((r) => r.results[0].id as string);
    const findApplicantId = (gref: string) =>
      hs(`/crm/v3/objects/${OBJ}/search`, "POST", { filterGroups: [{ filters: [{ propertyName: "applicant_id", operator: "EQ", value: gref }] }], properties: ["applicant_id"], limit: 1 })
        .then((r) => r.results?.[0]?.id ?? null);
    const findCompanyId = (key: string) =>
      hs(`/crm/v3/objects/${COMPANIES}/search`, "POST", { filterGroups: [{ filters: [{ propertyName: "crm_company_key", operator: "EQ", value: key }] }], properties: ["crm_company_key"], limit: 1 })
        .then((r) => r.results?.[0]?.id ?? null);
    const assocTyped = (fromType: string, fromId: string, toId: string, category: string, typeId: number) =>
      hs(`/crm/v4/objects/${fromType}/${fromId}/associations/${COMPANIES}/${toId}`, "PUT", [{ associationCategory: category, associationTypeId: typeId }]);
    const assocPrimary = (fromId: string, toId: string) =>
      hs(`/crm/v4/objects/${OBJ}/${fromId}/associations/default/${COMPANIES}/${toId}`, "PUT");

    // ---- property builder from config --------------------------------
    /* The group a brand belongs to. Prefers the real group added by
       20260813010000 and falls back to the free-text group_name, so agencies
       that have not been placed in a group yet keep syncing exactly as they do
       now rather than losing a property. */
    const groupNames = new Map<string, string>();
    {
      const { data: gs } = await service
        .from("agencies").select("id, group_id, group_name, agency_groups(name)");
      for (const a of (gs ?? []) as any[]) {
        const real = a.agency_groups?.name as string | undefined;
        const v = real ?? a.group_name ?? null;
        if (v) groupNames.set(a.id, v);
      }
    }
    const ctxGroupName = (agency: any) => groupNames.get(agency.id) ?? agency.group_name ?? null;

    const buildApplicantProps = (rows: FieldRow[], ctx: any): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const r of rows) {
        let v: unknown = null;
        switch (r.source_kind) {
          case "col": v = ctx.app[r.source]; break;
          case "const": v = r.source; break;
          case "pipeline": v = env.pipeline_id; break;
          case "stage": v = (env as any)[`stage_${r.source}`]; break;
          case "payment_status": v = r.source; break;
          case "event": v = ctx.event?.[r.source]; break;
          case "derived":
            v = r.source === "full_name" ? [ctx.app.tenant_first_name, ctx.app.tenant_last_name].filter(Boolean).join(" ")
              : r.source === "partner_id" ? ctx.partnerHsId
              : r.source === "agency_ref" ? ctx.agencyRef
              : r.source === "deed_url" ? ctx.deedUrl
              : r.source === "delivered_to" ? ctx.deliveredTo
              // Attribution. channel is how the application arrived; brand and
              // group are where it came from. All three are read once per event
              // in one round trip rather than joined per property.
              : r.source === "channel" ? ctx.attribution?.channel
              : r.source === "brand_name" ? ctx.attribution?.brand_name
              : r.source === "group_name" ? ctx.attribution?.group_name
              : null;
            break;
        }
        const tv = transformValue(v, r.transform);
        if (tv !== null) out[r.hs_property] = tv;
      }
      for (const k of Object.keys(out)) if (NEVER_TOUCH.has(k)) { delete out[k]; summary.warnings.push(`dropped never-touch ${k}`); }
      return out;
    };

    // ---- company sync (§6) -------------------------------------------
    // Returns the company ids/keys to associate the applicant to. Mints ONLY
    // confirmed entities. Single-office (1 confirmed branch) => ONE company that
    // serves both agency and branch roles; multi-branch => agency parent + branch
    // child, parent-child linked.
    const syncCompanies = async (agencyId: string, branchId: string) => {
      const { data: org } = await service.rpc("hubspot_org_context", { p_agency: agencyId, p_branch: branchId });
      const agency = org?.agency, branch = org?.branch;
      if (!agency || agency.review_state !== "confirmed") {
        summary.warnings.push(`agency ${agencyId} not confirmed, company and associations gated (§6)`);
        return { agencyKey: null, branchKey: null, agencyCoId: null, branchCoId: null, single: null };
      }
      const agencyKey = `RFL:${String(agency.id).slice(0, 8)}`;
      const single = (org.confirmed_branch_count ?? 0) <= 1;
      // #14 commission_rate = the agent commission rate (fraction) for this company's partner.
      const { data: prt } = await service.from("partners").select("agent_rate").eq("id", agency.partner_id).maybeSingle();
      const commissionRate = prt?.agent_rate != null ? String(prt.agent_rate) : null;
      const co = (vals: Record<string, string | null>) => {
        const props: Record<string, string> = {};
        for (const [logical, value] of Object.entries(vals)) {
          if (value === null || value === undefined || value === "") continue;
          const hp = companyNameFor(logical); if (!hp) continue;
          if (NEVER_TOUCH.has(hp)) continue;
          props[hp] = String(value);
        }
        return props;
      };

      if (single) {
        // ONE company: agency-level, head_office_ = Yes, serves agency + branch.
        const id = await upsertCompany(agencyKey, co({
          company_key: agencyKey, company_name: agency.name, agency_name: agency.name,
          company_level: "Group HQ / Brand", head_office: "Yes", network_group: ctxGroupName(agency),
          commission_rate: commissionRate,
        }));
        return { agencyKey, branchKey: agencyKey, agencyCoId: id, branchCoId: id, single: true };
      }

      // Multi-branch: agency = parent, branch = child.
      const parentId = await upsertCompany(agencyKey, co({
        company_key: agencyKey, company_name: agency.name, agency_name: agency.name,
        company_level: "Group HQ / Brand", head_office: null, network_group: ctxGroupName(agency),
        commission_rate: commissionRate,
      }));
      let branchKey: string | null = null, branchCoId: string | null = null;
      if (branch && branch.review_state === "confirmed") {
        branchKey = `RFL:${String(branch.id).slice(0, 8)}`;
        const isHeadOffice = /head\s*office/i.test(branch.name ?? "");
        branchCoId = await upsertCompany(branchKey, co({
          company_key: branchKey, company_name: `${agency.name}, ${branch.name}`, agency_name: agency.name,
          branch_name: branch.name, company_level: "Branch", head_office: isHeadOffice ? "Yes" : "No",
          commission_rate: commissionRate,
        }));
        // parent-child link: child -> parent ("Parent Company").
        //
        // An unset association type id is CONFIG, not data. HubSpot answers a
        // PUT carrying a null associationTypeId with a 400, which threw, which
        // froze this partner's whole queue for good. That is not hypothetical:
        // the production hubspot_sync_env row ships with the branch type id
        // NULL (HANDOVER-MACHINE §6.4), so promotion without setting the ids
        // would poison every event from the first one. Gate instead: report the
        // gap, hand back no branch, and let the §6 not-ready path complete the
        // branch role on a later event once the id is set.
        if (env.company_parent_type_id == null) {
          await configGap(`hubspot_sync_env '${env.env}' has no company_parent_type_id, so a branch company cannot be linked to its parent`);
          return { agencyKey, branchKey: null, agencyCoId: parentId, branchCoId: null, single: false };
        }
        await assocTyped(COMPANIES, branchCoId!, parentId, env.company_parent_category, env.company_parent_type_id);
      } else {
        summary.warnings.push(`branch ${branchId} not confirmed, branch company and association gated (§6)`);
      }
      return { agencyKey, branchKey, agencyCoId: parentId, branchCoId, single: false };
    };

    // ---- associations (§7) -------------------------------------------
    // Owner ruling: exactly TWO company edges per applicant.
    //   1. the partner company (Rightmove/Zoopla) — always, PRIMARY (unlabeled type)
    //   2. the referring agent's BRANCH company — for a multi-branch group the
    //      applicant links to the specific branch child (NOT the group parent);
    //      for a single-office agency the single company plays the branch role.
    // Agency/group-level rollups traverse the branch->parent company link (§6), so
    // there is no direct applicant->parent edge. Exactly two edges, which also sits
    // within the sandbox's 2-companies-per-record association cap.
    //
    // Per-APPLICATION role ledger: the branch is minted/attached only once its org
    // is confirmed (§6 gate). If a referral lands before confirmation, the partner
    // edge is made now and the branch edge is completed on a LATER event once the
    // org is confirmed (§1) — the state is keyed on the application, not the event.
    //
    // WHY THE TWO CONFIG CHECKS BELOW GATE RATHER THAN THROW. Both used to be
    // `throw`, and both are config states that persist until a human changes
    // config: a partner with no hubspot_partner_map row, and a partner company
    // that does not exist in the Hub. A throw here stops the partner at this
    // event and the cron retries the same event every two minutes, so a config
    // gap did not delay that partner's sync, it ENDED it, and the only trace
    // was one ops-alert in the first hour. Nothing downstream reads
    // stuck_since, so nobody found out from the system.
    //
    // A missing hubspot_partner_map row is not a rare state. The seed migration
    // (20260705150500) filled the table from `partners` AS IT WAS THAT DAY, and
    // nothing has filled it since: the trigger added with the per-partner
    // cursors seeds hubspot_sync_cursor_partner on insert and has no companion
    // for the map. Every partner created after the seed ran therefore has a
    // cursor, has events, and has no map row. On dev that is all seven of them.
    //
    // Gating matches what §6 already does for an unconfirmed org: the edge is
    // skipped, nothing is recorded, and the ledger's per-APPLICATION key means a
    // later event for the same application completes it once config lands. The
    // applicant properties still reach HubSpot in the meantime, which is the
    // part that would otherwise be lost outright.
    const ensureAssoc = async (app: any, applicantId: string, eventId: string) => {
      if (!(await applied(`assoc:${app.id}:partner`))) {
        const pm = partnerMap.get(app.partner_id);
        if (!pm) {
          await configGap(`no active hubspot_partner_map row for partner ${app.partner_id}, so the PRIMARY partner association cannot be made`);
        } else {
          const partnerCoId = await findCompanyId(pm.partner_company_key);
          if (!partnerCoId) {
            await configGap(`partner company ${pm.partner_company_key} does not exist in HubSpot, so the PRIMARY partner association cannot be made`);
          } else {
            await assocPrimary(applicantId, partnerCoId); // partner = PRIMARY (the one Workflow E reads)
            await record(`assoc:${app.id}:partner`, eventId, "assoc_partner", app.id);
          }
        }
      }
      if (!(await applied(`assoc:${app.id}:branch`))) {
        const c = await syncCompanies(app.agency_id, app.branch_id); // §6 gate mints only confirmed orgs
        if (c.branchCoId) {
          if (env.company_branch_type_id == null) {
            await configGap(`hubspot_sync_env '${env.env}' has no company_branch_type_id, so the applicant cannot be associated to its branch company`);
            return; // unrecorded: completed on a later event once the id is set
          }
          await assocTyped(OBJ, applicantId, c.branchCoId, env.company_branch_category, env.company_branch_type_id);
          if (AREF_PROP && c.branchKey) await upsertApplicant(app.guarantee_ref, { [AREF_PROP]: c.branchKey });
          await record(`assoc:${app.id}:branch`, eventId, "assoc_branch", app.id);
        }
        // else: org still pending_review — leave unrecorded; re-attempted next event.
      }
    };

    const deliveredTo = async (branchId: string, agencyId: string): Promise<string | null> => {
      const q = async (col: string, id: string) => {
        const { data } = await service.from("agent_contacts").select("email").eq(col, id).eq("is_primary", true).limit(1).maybeSingle();
        return data?.email ?? null;
      };
      return (await q("branch_id", branchId)) ?? (await q("agency_id", agencyId));
    };

    // ---- per-PARTNER, then per-event ----------------------------------
    // The inner `break` on error is what makes this partitioning matter: it
    // stops THIS partner at its own cursor and the outer loop moves on, so a
    // partner that cannot sync no longer holds anybody else's feed.
    for (const pc of partnerCursors) {
      const partnerId = pc.partner_id;
      const { data: events, error: evErr } = await service.rpc("hubspot_pending_events", {
        p_partner: partnerId, p_last_at: pc.last_at, p_last_id: pc.last_id,
        p_kinds: Object.keys(KIND_TO_EVENT), p_limit: LIMIT,
      });
      if (evErr) {
        // THE DEPLOY-ORDER FAILURE LANDS HERE. 20260812030000 drops the old
        // four-argument hubspot_pending_events and creates the five-argument
        // one, so a bundle older than that migration gets PGRST202 "Could not
        // find the function" on every run, for every partner, for ever. That
        // migration says to apply it and deploy this function together, and the
        // window is expected to be noisy; it was not, because this branch only
        // set stuck_since and nothing reads stuck_since. It alerts now.
        summary.errors.push({ partner: partnerId, error: `fetch events: ${evErr.message}` });
        await service.rpc("hubspot_mark_stuck", { p_partner: partnerId, p_error: `fetch events: ${evErr.message}` });
        await incident(`hubspot_sync_error:${partnerId}`, `hubspot-sync could not read the queue for partner ${partnerId}: ${evErr.message}`);
        continue;
      }

      // Sandbox rows must never reach HubSpot. They are already excluded in SQL, by
      // the livemode predicate on hubspot_pending_events, so anything arriving here
      // with livemode false means that predicate has been removed or the cursor is
      // being fed from somewhere else. Drop it and say so loudly rather than
      // trusting the layer below: a test contact and a test deal in the production
      // CRM is the most expensive leak in this system to undo by hand.
      const clean = (events ?? []).filter((e: any) => {
        if (maySyncToHubspot(e?.app?.livemode !== false)) return true;
        summaryWarn.push(`refused sandbox application ${e?.application_id} (event ${e?.event_id})`);
        return false;
      });

      let partnerProcessed = 0;
      let partnerStuck = false;

      for (const ev of clean) {
        const app = ev.app;
        const eventType = KIND_TO_EVENT[ev.kind];
        try {
          // 1. Applicant property upsert (per-event idempotency). Config-driven props.
          const rows = applicantRows.filter((r) => r.events.includes(eventType));
          const ctx: any = { app, event: { at: ev.at } };
          // One call, not four joins. Fails soft: an unattributed record is
          // worse than none but a BLOCKED sync is worse than both, and the
          // cursor is per partner now so a failure here would stall that
          // partner's whole feed.
          try {
            const { data: attr } = await service.rpc("application_attribution", { p_application: app.id });
            ctx.attribution = Array.isArray(attr) ? attr[0] : attr;
          } catch { ctx.attribution = null; }
          if (eventType === "referral") ctx.partnerHsId = partnerMap.get(app.partner_id)?.hs_partner_id ?? null;
          if (eventType === "deed_issued") ctx.deedUrl = APP_BASE ? `${APP_BASE}/applications/${app.guarantee_ref}` : null;
          if (eventType === "delivered") ctx.deliveredTo = await deliveredTo(app.branch_id, app.agency_id);
          const props = buildApplicantProps(rows, ctx);
          let applicantId: string | null = null;
          if (Object.keys(props).length && !(await applied(`${ev.event_id}:applicant`))) {
            applicantId = await upsertApplicant(app.guarantee_ref, props);
            await record(`${ev.event_id}:applicant`, ev.event_id, "applicant", app.id);
          }

          // 2. Associations (partner PRIMARY + branch). Referral always ensures; other
          //    events re-attempt only if an edge is still missing (e.g. the org was
          //    confirmed after the referral). Per-application role ledger, idempotent.
          const needAssoc = eventType === "referral"
            || !(await applied(`assoc:${app.id}:partner`))
            || !(await applied(`assoc:${app.id}:branch`));
          if (needAssoc) {
            if (!applicantId) applicantId = await findApplicantId(app.guarantee_ref);
            if (!applicantId && eventType === "referral" && Object.keys(props).length)
              applicantId = await upsertApplicant(app.guarantee_ref, props);
            if (applicantId) await ensureAssoc(app, applicantId, ev.event_id);
          }

          // advance THIS PARTNER's cursor to this event (last success). Also
          // clears stuck_since, so recovery is recorded by the same call that
          // records progress and the two can never disagree.
          //
          // Checked, because an unchecked cursor advance is the quietest
          // failure in the file: supabase-js returns the error instead of
          // throwing it, so the run would count the event as processed, return
          // 200, and re-process the same events on the next run and every run
          // after. Raised into the catch, which alerts.
          const { error: curErr } = await service.rpc("hubspot_mark_cursor", { p_partner: partnerId, p_last_at: ev.at, p_last_id: ev.event_id });
          if (curErr) throw new Error(`cursor advance: ${curErr.message}`);
          summary.processed++;
          partnerProcessed++;
          summary.by[eventType] = (summary.by[eventType] ?? 0) + 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          summary.errors.push({ partner: partnerId, ref: app?.guarantee_ref, kind: ev.kind, error: msg });

          // ---- bounded retry, then park -------------------------------
          //
          // The break below is head-of-line blocking, and on its own it is
          // unbounded: an event that can never succeed is retried every two
          // minutes for ever and nothing behind it in that partner's queue is
          // ever synced. Partitioning the cursor per partner shrank the blast
          // radius from "the CRM" to "one partner"; it did not put a floor
          // under it. This does. There is still no proper dead-letter queue
          // with backoff, which is HANDOVER B7.5 and a rewrite; what there is
          // now is a limit, a record and an alert.
          //
          // Attempts are counted as ledger rows rather than a column because
          // hubspot_sync_events already exists with a text primary key and an
          // index on event_id, and adding a column is a migration this change
          // does not need. If the count cannot be read the event is treated as
          // failing for the first time, which degrades to exactly the old
          // behaviour: block, do not park.
          const { data: priorRaw } = await service
            .from("hubspot_sync_events").select("applied_at")
            .eq("event_id", ev.event_id).eq("target", FAILED)
            .order("applied_at", { ascending: true });
          const prior = priorRaw ?? [];
          const attempts = prior.length + 1;
          const firstFailedMs = prior.length ? Date.parse(prior[0].applied_at as string) : Date.now();
          await recordSoft(`fail:${ev.event_id}:${attempts}`, ev.event_id, FAILED, app?.id ?? null);

          const park = attempts >= MAX_ATTEMPTS && (Date.now() - firstFailedMs) >= PARK_AFTER_MS;
          const where = `${ev.kind} ${app?.guarantee_ref ?? ""} (event ${ev.event_id}, attempt ${attempts})`;

          if (park) {
            // Its own alert type, so the park cannot be swallowed by the
            // ordinary error's once-an-hour dedupe, and still prefixed
            // hubspot_sync_error so existing greps and filters find it.
            await recordSoft(`dead:${ev.event_id}`, ev.event_id, DEAD_LETTER, app?.id ?? null);
            const { error: skipErr } = await service.rpc("hubspot_mark_cursor", { p_partner: partnerId, p_last_at: ev.at, p_last_id: ev.event_id });
            summary.parked.push({ partner: partnerId, event_id: ev.event_id, ref: app?.guarantee_ref ?? null, kind: ev.kind, attempts, error: msg, skipped: !skipErr });
            await incident(`hubspot_sync_error:dead_letter:${partnerId}`,
              `hubspot-sync PARKED ${where} after ${Math.round((Date.now() - firstFailedMs) / 60000)} minutes of failing: ${msg}. It is recorded in hubspot_sync_events as dead_letter and the queue has moved past it; it will NOT reach HubSpot until it is replayed.`);
            // Parking is a decision, not a fault state: the cursor advance
            // cleared stuck_since, so do not re-stick the partner, and do not
            // break. The rest of its queue drains in this same run.
            if (!skipErr) continue;
          }

          // stuck_since keeps its FIRST value, so the staleness alert measures how
          // long this partner has actually been stuck rather than resetting on
          // every run that retries and fails again.
          await service.rpc("hubspot_mark_stuck", { p_partner: partnerId, p_error: `${ev.kind} ${app?.guarantee_ref ?? ""}: ${msg}` });
          // Partner-suffixed type: ops_alerts dedupes on (alert_type,
          // application_id, hour_bucket) and this call passes no application,
          // so the un-suffixed type meant the first partner to fail in an hour
          // hid every other partner that failed in the same hour.
          await incident(`hubspot_sync_error:${partnerId}`, `hubspot-sync ${where}: ${msg}`);
          partnerStuck = true;
          break; // this partner only; its cursor holds and the next partner runs
        }
      }

      summary.partners.push({ partner: partnerId, processed: partnerProcessed, stuck: partnerStuck });
    }

    // What a successful run RECORDS, in the run's own answer. A run that
    // processed events and left the ledger empty is the signature of a sync
    // that looks healthy and is writing nothing, so the count that proves it
    // belongs next to the count that claims it.
    {
      const { count } = await service
        .from("hubspot_sync_events").select("id", { count: "exact", head: true });
      summary.ledger_rows = count ?? null;
    }

    // A partner that failed is reported, but the run is only "not ok" in the
    // 207 sense: the other partners drained, which is the entire point.
    summary.ok = summary.errors.length === 0;
    summary.ms = Date.now() - started;
    return json(summary, summary.ok ? 200 : 207);
  } catch (e) {
    // Nothing reached the CRM on this run and the response is a 500 the cron
    // does not read. Alert, on a type of its own so it is not deduped against
    // a per-partner failure in the same hour.
    const msg = e instanceof Error ? e.message : "Unexpected error.";
    await incident("hubspot_sync_error:run", `hubspot-sync run aborted before any partner completed: ${msg}`);
    return json({ ok: false, error: msg }, 500);
  }
});
