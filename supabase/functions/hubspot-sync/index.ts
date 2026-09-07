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
//                     report_ops_incident('hubspot_sync_error', …); the cursor
//                     holds at the last success so the batch retries safely.
//
// Auth (manual/cron trigger): x-ops-secret matched against REMINDERS_CRON_SECRET
// (edge env) OR the ops_secrets 'reminders_cron' mirror — the same shape as
// ops-alert / the reminder crons. The sandbox smoke invokes it exactly like a
// cron would: via pg_net, with the secret read from ops_secrets inside SQL.
// HubSpot token resolution: HUBSPOT_ACCESS_TOKEN (edge env, set on the project)
// -> x-hubspot-token header -> ops_secrets 'hubspot_access_token'.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

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
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const CRON_SECRET = Deno.env.get("REMINDERS_CRON_SECRET") ?? "";
    const service = createClient(SUPABASE_URL, SERVICE);

    // ---- auth (x-ops-secret vs edge env OR ops_secrets mirror) --------
    const presented = req.headers.get("x-ops-secret") ?? "";
    let authed = Boolean(presented) && Boolean(CRON_SECRET) && presented === CRON_SECRET;
    if (!authed && presented) {
      const { data: sec } = await service.from("ops_secrets").select("secret").eq("name", "reminders_cron").maybeSingle();
      if (sec?.secret && presented === sec.secret) authed = true;
    }
    if (!authed) return json({ ok: false, error: "Not authorised." }, 401);

    // ---- HubSpot token ------------------------------------------------
    let TOKEN = Deno.env.get("HUBSPOT_ACCESS_TOKEN") ?? req.headers.get("x-hubspot-token") ?? "";
    if (!TOKEN) {
      const { data: sec } = await service.from("ops_secrets").select("secret").eq("name", "hubspot_access_token").maybeSingle();
      TOKEN = sec?.secret ?? "";
    }
    if (!TOKEN) return json({ ok: false, error: "No HubSpot access token configured." }, 500);

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
    if (envErr || !env) return json({ ok: false, error: "No active HubSpot environment configured." }, 500);
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

    // ---- cursor -------------------------------------------------------
    const { data: cur } = await service.from("hubspot_sync_cursor").select("*").eq("id", true).maybeSingle();
    if (!cur) return json({ ok: false, error: "Cursor not initialised." }, 500);

    const LIMIT = Number((await req.json().catch(() => ({})))?.limit ?? 200);
    const { data: events, error: evErr } = await service.rpc("hubspot_pending_events", {
      p_last_at: cur.last_at, p_last_id: cur.last_id, p_kinds: Object.keys(KIND_TO_EVENT), p_limit: LIMIT,
    });
    if (evErr) {
      return json({ ok: false, error: "Could not load sync events." }, 500);
    }

    const summary: any = { ok: true, env: env.env, processed: 0, by: {}, warnings: [], errors: [], cursor_start: { at: cur.last_at, id: cur.last_id } };

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
    const record = async (id: string, eventId: string, target: string, appId: string | null) => {
      await service.from("hubspot_sync_events").upsert(
        { id, event_id: eventId, target, application_id: appId }, { onConflict: "id", ignoreDuplicates: true });
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
        summary.warnings.push(`agency ${agencyId} not confirmed — company/associations gated (§6)`);
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
          company_level: "Group HQ / Brand", head_office: "Yes", network_group: agency.group_name,
          commission_rate: commissionRate,
        }));
        return { agencyKey, branchKey: agencyKey, agencyCoId: id, branchCoId: id, single: true };
      }

      // Multi-branch: agency = parent, branch = child.
      const parentId = await upsertCompany(agencyKey, co({
        company_key: agencyKey, company_name: agency.name, agency_name: agency.name,
        company_level: "Group HQ / Brand", head_office: null, network_group: agency.group_name,
        commission_rate: commissionRate,
      }));
      let branchKey: string | null = null, branchCoId: string | null = null;
      if (branch && branch.review_state === "confirmed") {
        branchKey = `RFL:${String(branch.id).slice(0, 8)}`;
        const isHeadOffice = /head\s*office/i.test(branch.name ?? "");
        branchCoId = await upsertCompany(branchKey, co({
          company_key: branchKey, company_name: `${agency.name} — ${branch.name}`, agency_name: agency.name,
          branch_name: branch.name, company_level: "Branch", head_office: isHeadOffice ? "Yes" : "No",
          commission_rate: commissionRate,
        }));
        // parent-child link: child -> parent ("Parent Company")
        await assocTyped(COMPANIES, branchCoId!, parentId, env.company_parent_category, env.company_parent_type_id);
      } else {
        summary.warnings.push(`branch ${branchId} not confirmed — branch company/association gated (§6)`);
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
    const ensureAssoc = async (app: any, applicantId: string, eventId: string) => {
      if (!(await applied(`assoc:${app.id}:partner`))) {
        const pm = partnerMap.get(app.partner_id);
        if (!pm) throw new Error(`no partner map for partner_id ${app.partner_id}`);
        const partnerCoId = await findCompanyId(pm.partner_company_key);
        if (!partnerCoId) throw new Error(`partner company ${pm.partner_company_key} not found in HubSpot`);
        await assocPrimary(applicantId, partnerCoId); // partner = PRIMARY (the one Workflow E reads)
        await record(`assoc:${app.id}:partner`, eventId, "assoc_partner", app.id);
      }
      if (!(await applied(`assoc:${app.id}:branch`))) {
        const c = await syncCompanies(app.agency_id, app.branch_id); // §6 gate mints only confirmed orgs
        if (c.branchCoId) {
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

    // ---- per-event processing ----------------------------------------
    for (const ev of (events ?? [])) {
      const app = ev.app;
      const eventType = KIND_TO_EVENT[ev.kind];
      try {
        // 1. Applicant property upsert (per-event idempotency). Config-driven props.
        const rows = applicantRows.filter((r) => r.events.includes(eventType));
        const ctx: any = { app, event: { at: ev.at } };
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

        // advance cursor to this event (last success)
        await service.from("hubspot_sync_cursor").update({ last_at: ev.at, last_id: ev.event_id, updated_at: new Date().toISOString() }).eq("id", true);
        summary.processed++;
        summary.by[eventType] = (summary.by[eventType] ?? 0) + 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.errors.push({ ref: app?.guarantee_ref, kind: ev.kind, error: msg });
        try {
          await service.rpc("report_ops_incident", { p_type: "hubspot_sync_error", p_detail: `hubspot-sync ${ev.kind} ${app?.guarantee_ref ?? ""}: ${msg}` });
        } catch { /* never mask the original error */ }
        break; // stop; cursor holds at last success; the batch retries next run
      }
    }

    summary.ok = summary.errors.length === 0;
    summary.ms = Date.now() - started;
    return json(summary, summary.ok ? 200 : 207);
  } catch (e) {
    return json({ ok: false, error: "HubSpot sync could not be completed." }, 500);
  }
});
