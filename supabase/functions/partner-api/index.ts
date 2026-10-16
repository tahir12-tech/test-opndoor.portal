// =====================================================================
// partner-api (verify_jwt = FALSE, required)
//
// The partner-facing API surface. See PARTNER-API.md. Stage B implements one
// endpoint, GET /orgs. The router exists so later endpoints slot in without
// each one re-implementing authentication.
//
// DEPLOYMENT: this function MUST be deployed with verify_jwt = false. It
// authenticates with a partner API key in the Authorization header, not a
// Supabase JWT, so leaving JWT verification on rejects every legitimate request
// before this code runs. There is no config.toml in this repo, so verify_jwt is
// a dashboard setting and is not versioned. Same posture as stripe-webhook and
// payment-page.
//
// WHY ONE FUNCTION WITH A ROUTER, rather than one Edge Function per endpoint as
// the other twenty functions here do. This is a deliberate departure. The
// partner API is a multi-endpoint surface that shares authentication, scope
// checks, rate limiting and an error contract. Splitting it per endpoint would
// duplicate the key-verification path, which is the one piece of this that most
// needs to exist exactly once.
//
// PARTNERS ARE GIVEN https://api.opndoor.co/v1/..., which rewrites to this
// function's /functions/v1/partner-api/v1/... path. The hostname and the rewrite
// are configuration that has to be set up; see HANDOVER.md section 12. Use the
// function URL for internal testing only: whatever a partner is handed gets
// hardcoded, so it has to be a host and path we can change.
//
// SCOPING: RLS DOES NOT PROTECT THIS PATH. Every table carries a restrictive
// AAL2 policy an API-key request can never satisfy, so this runs as service
// role. Partner isolation is entirely this file's responsibility. Every query
// must filter on auth.partnerId, which is derived from the verified key and
// never from a payload.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AUTH_FAILURE_BODY,
  authenticatePartner,
  hasScope,
  touchKey,
} from "../_shared/partnerAuth.ts";
import { createApplication, requestHash } from "../_shared/partnerApplications.ts";
import { redactRawBody } from "../_shared/redact.ts";
import { generateEndpointSecret } from "../_shared/webhookSigning.ts";
import { applicationView, decodeCursor, encodeCursor, type ApplicationRow } from "../_shared/partnerViews.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/**
 * Rate limit headers, set once the per-key window is known and then attached to
 * every response including errors.
 *
 * Module-scope would be wrong: this runs per request and a module variable would
 * leak one caller's remaining count to the next. It is threaded through the
 * request closure instead.
 */
type RateHeaders = Record<string, string>;

/** Rate limits. */
const LIMITS = {
  // FAILED authentications per origin. This is the auth-path protection: without
  // it, key guessing is free, because every attempt costs us a hash and a
  // database lookup.
  //
  // It counts FAILURES, not requests. The previous version counted every request
  // before verification and capped an origin at 60/min, which protected the auth
  // path and also silently capped a legitimate partner at a tenth of their
  // per-key allowance. Nothing surfaced that: they saw 429s while
  // X-RateLimit-Remaining still read in the hundreds, because the header
  // reported the per-key window and the refusal came from the other limiter.
  authFailuresPerIp: { limit: 60, windowSecs: 60 },
  perKey: { limit: 600, windowSecs: 60 },
};

/**
 * Seconds until the window resets, for Retry-After.
 *
 * Floored at 1 rather than 0: `Retry-After: 0` invites an immediate retry, which
 * arrives inside the same window and is refused again. A client obeying it
 * would hot-loop.
 */
function retryAfterSecs(resetAt: string | null | undefined): number {
  if (!resetAt) return 60;
  const secs = Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000);
  return Number.isFinite(secs) ? Math.min(Math.max(secs, 1), 3600) : 60;
}

function json(body: unknown, status: number, requestId: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, ...extra, "Content-Type": "application/json", "X-Request-Id": requestId },
  });
}

/**
 * Observability log, one row per request.
 *
 * Deliberately NOT partner_api_requests: that is the idempotency ledger, keyed
 * on an idempotency key that reads do not have, so every GET would be invisible.
 * Monitoring built on it would under-report by however many reads a partner
 * makes, which is worse than no monitoring because it looks authoritative.
 *
 * Fire and forget, and never awaited: an observability write must not be able to
 * slow down or fail the request it is observing. The RPC swallows its own errors
 * for the same reason.
 */
// deno-lint-ignore no-explicit-any
function logRequest(service: any, fields: {
  partnerId: string | null; apiKeyId: string | null; method: string; path: string;
  status: number; errorCode: string | null; startedAt: number;
  requestBody: unknown; responseBody: unknown;
}): void {
  service.rpc("log_partner_api_request", {
    p_partner: fields.partnerId,
    p_api_key: fields.apiKeyId,
    p_method: fields.method,
    p_path: fields.path,
    p_status: fields.status,
    p_error_code: fields.errorCode,
    p_duration_ms: Math.round(performance.now() - fields.startedAt),
    p_request_body: fields.requestBody ?? null,
    p_response_body: fields.responseBody ?? null,
  }).then(() => {}).catch(() => {});
}

/**
 * Bodies are capped before they are parsed, not after.
 *
 * A 10MB body redacts to a small object, so capping afterwards would still mean
 * parsing it, holding it, and doing it on the logging path of a request that has
 * already been answered. The cap is generous next to a real application payload,
 * which is around 700 bytes.
 */
const MAX_LOGGED_BODY = 64 * 1024;

async function bodyForLog(source: Request | Response): Promise<unknown> {
  try {
    const raw = await source.text();
    if (!raw) return null;
    if (raw.length > MAX_LOGGED_BODY) {
      return { "[oversized]": `${raw.length} bytes, not logged` };
    }
    return redactRawBody(raw);
  } catch {
    return null;
  }
}

/**
 * Did this miss name something real that belongs to somebody else?
 *
 * Called only after a request has already been refused, and it cannot change the
 * refusal. Fire and forget, and it swallows its own errors: a detection that
 * breaks the request it is observing is worse than no detection.
 */
// deno-lint-ignore no-explicit-any
async function crossPartnerCheck(
  service: any, kind: "application" | "branch", id: string, partnerId: string, requestId: string,
): Promise<void> {
  try {
    const table = kind === "application" ? "applications" : "branches";
    const { data } = await service.from(table).select("partner_id").eq("id", id).maybeSingle();
    if (!data || data.partner_id === partnerId) return;   // genuinely unknown, or ours after all

    console.log(JSON.stringify({ requestId, event: "cross_partner_attempt", kind }));
    await service.rpc("record_security_event", {
      p_kind: "cross_partner_access",
      p_severity: "warn",
      p_partner: partnerId,
      p_detail: `A key for this partner requested a ${kind} belonging to another partner. Refused with the standard not-found response.`,
    });
  } catch {
    // deliberately silent
  }
}

/** The error code out of a response envelope, for the error distribution chart. */
function codeOf(body: unknown): string | null {
  const e = (body as { error?: { code?: string } } | null)?.error;
  return e?.code ?? null;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const reqUrl = new URL(req.url);
  // The path as the partner sees it, with the function mount stripped.
  const logPath = reqUrl.pathname.replace(/^.*\/partner-api/, "") || "/";

  // Set inside run() once known. Logging happens at ONE exit point below rather
  // than at each of the dozen returns, so a new endpoint cannot forget to log.
  let logPartnerId: string | null = null;
  let logKeyId: string | null = null;
  // deno-lint-ignore no-explicit-any
  let logService: any = null;

  // Cloned BEFORE run(), which consumes the body. Cloning afterwards returns a
  // request whose stream is already drained and yields an empty string rather
  // than an error, so every POST would quietly log as having sent nothing.
  // Only methods that carry a body: cloning a GET is work on every read.
  const reqForLog = (req.method === "POST" || req.method === "PATCH" || req.method === "PUT")
    ? req.clone()
    : null;

  // Filled once the per-key window is known, then attached to whatever run()
  // returns. Declared here rather than at module scope: this file handles many
  // requests in one isolate, and a module variable would show one caller their
  // predecessor's remaining count.
  let rateHeaders: RateHeaders = {};

  const run = async (): Promise<Response> => {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const service = createClient(SUPABASE_URL, SERVICE);
    logService = service;

    // ---- rate limit: unauthenticated tier, before any key work -------------
    // The RIGHTMOST hop: the leftmost is whatever the caller wrote, so it is a
    // fresh bucket per request. Round 7, D -- see _shared/rateLimit.ts. Here
    // it also feeds the repeated_auth_failure threshold below, which a forged
    // header would suppress permanently.
    const ip = (req.headers.get("x-forwarded-for") ?? "")
      .split(",").map((s: string) => s.trim()).filter(Boolean).pop() ?? "unknown";
    // Refuse an origin that is ALREADY over its failure budget, before spending
    // a hash on it. Checked with a zero-cost read rather than a bump, so a
    // legitimate request does not consume failure budget just by arriving.
    const { data: preRows } = await service.rpc("bump_rate_limit_state", {
      p_key: `papi:authfail:${ip}`,
      p_limit: LIMITS.authFailuresPerIp.limit,
      p_window_secs: LIMITS.authFailuresPerIp.windowSecs,
      p_peek: true,
    });
    const preState = Array.isArray(preRows) ? preRows[0] : preRows;
    if (preState?.allowed === false) {
      // The failure tier's numbers are deliberately not published in headers.
      // Telling an unauthenticated caller how many attempts remain helps whoever
      // is probing for valid key prefixes. Retry-After is enough to be well
      // behaved.
      return json(errorBody("rate_limited", "Too many requests."), 429, requestId, {
        "Retry-After": String(retryAfterSecs(preState?.reset_at)),
      });
    }

    // ---- authenticate ------------------------------------------------------
    const result = await authenticatePartner(req, service);
    if (!result.ok) {
      // Count the failure. This is what the pre-auth check above reads, so
      // repeated guessing from one origin stops being free after 60 tries a
      // minute, while a partner making 600 good calls is never touched by it.
      const { data: failRows } = await service.rpc("bump_rate_limit_state", {
        p_key: `papi:authfail:${ip}`,
        p_limit: LIMITS.authFailuresPerIp.limit,
        p_window_secs: LIMITS.authFailuresPerIp.windowSecs,
      });
      const failState = Array.isArray(failRows) ? failRows[0] : failRows;

      // A security event, not a log line, once failures from one origin stop
      // looking like a misconfigured integration and start looking like guessing.
      //
      // The threshold is deliberately not 1. A partner who deploys with the wrong
      // key generates a burst of failures and that is a support question, not an
      // attack. Ten in a window is past the point where a human would have
      // noticed and fixed it.
      //
      // record_security_event aggregates within the hour, so this writes ONE row
      // that counts up rather than one row per attempt, which is what stops an
      // attacker filling the table by continuing.
      const failuresSoFar = LIMITS.authFailuresPerIp.limit - Number(failState?.remaining ?? 0);
      if (failuresSoFar >= 10) {
        await service.rpc("record_security_event", {
          p_kind: "repeated_auth_failure",
          p_severity: failuresSoFar >= LIMITS.authFailuresPerIp.limit ? "critical" : "warn",
          p_origin: ip,
          p_detail: `${failuresSoFar} failed authentications from this origin within the window. Last reason: ${result.reason}.`,
        }).then(() => {}, () => {});
      }

      // The reason is logged and never returned. Every failure looks the same.
      console.log(JSON.stringify({ requestId, event: "auth_failed", reason: result.reason }));
      return json(AUTH_FAILURE_BODY, 401, requestId);
    }
    const auth = result.auth;
    logPartnerId = auth.partnerId;
    logKeyId = auth.apiKeyId;

    // ---- rate limit: per key ----------------------------------------------
    const { data: keyRows } = await service.rpc("bump_rate_limit_state", {
      p_key: `papi:key:${auth.apiKeyId}`,
      p_limit: LIMITS.perKey.limit,
      p_window_secs: LIMITS.perKey.windowSecs,
    });
    const keyState = Array.isArray(keyRows) ? keyRows[0] : keyRows;

    // Set for the rest of the request, so every response below carries them and
    // a partner learns where they stand from a successful call rather than only
    // from being refused.
    if (keyState) {
      rateHeaders = {
        "X-RateLimit-Limit": String(keyState.limit_count),
        "X-RateLimit-Remaining": String(keyState.remaining),
        // Seconds, matching Retry-After's unit and the convention most clients
        // expect. An ISO timestamp here reads as a date to a human and as an
        // error to a parser expecting a number.
        "X-RateLimit-Reset": String(Math.max(0, Math.floor(new Date(keyState.reset_at).getTime() / 1000))),
      };
    }

    if (keyState?.allowed === false) {
      return json(errorBody("rate_limited", "Too many requests."), 429, requestId, {
        ...rateHeaders,
        "Retry-After": String(retryAfterSecs(keyState?.reset_at)),
      });
    }

    touchKey(service, auth.apiKeyId);

    // ---- partner must be active -------------------------------------------
    // Safe to disclose: the caller has already proved which partner they are.
    const { data: partner } = await service
      .from("partners")
      .select("id, status, referencing_mode")
      .eq("id", auth.partnerId)
      .maybeSingle();

    if (!partner || partner.status !== "active") {
      return json(
        errorBody("partner_inactive", "This partner account is not active."),
        403,
        requestId,
      );
    }

    // ---- route -------------------------------------------------------------
    // Path is /functions/v1/partner-api/<api version>/<endpoint>. Segments are
    // taken relative to the function name so it can be renamed or remounted
    // without breaking this.
    //
    // NOTE THE TWO DIFFERENT v1s. The first is Supabase's Edge Function API
    // version and is not ours to change. The second is THIS API's version, and
    // it exists so a breaking change can ship without breaking every partner at
    // once.
    //
    // THE VERSION IS REQUIRED, not defaulted. Treating a missing segment as v1
    // would be friendlier today and useless later: the clients that never sent a
    // version are exactly the ones a v2 would break, which is the problem the
    // segment exists to solve. Nobody has integrated yet, so there is no
    // compatibility to preserve and every client is explicit from the first call.
    const segments = new URL(req.url).pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("partner-api");
    const rest = idx >= 0 ? segments.slice(idx + 1) : [];
    const apiVersion = rest[0] ?? "";
    const endpoint = rest.slice(1).join("/");

    // Adding v2 means adding it here and branching per endpoint. Versions are
    // public API surface, so naming the supported ones in the error is helpful
    // to an integrator and discloses nothing.
    const SUPPORTED_VERSIONS = ["v1"];
    if (!SUPPORTED_VERSIONS.includes(apiVersion)) {
      return json(
        errorBody(
          "unsupported_version",
          `Prefix the path with an API version. Supported: ${SUPPORTED_VERSIONS.join(", ")}.`,
        ),
        404,
        requestId,
      );
    }

    if (endpoint === "orgs") {
      if (req.method !== "GET") {
        return json(errorBody("method_not_allowed", "Use GET."), 405, requestId, { Allow: "GET" });
      }
      if (!hasScope(auth, "orgs:read")) {
        return json(errorBody("insufficient_scope", "This key lacks the orgs:read scope."), 403, requestId);
      }
      return await getOrgs(service, auth.partnerId, requestId);
    }

    if (endpoint === "applications") {
      if (req.method === "GET") {
        if (!hasScope(auth, "applications:read")) {
          return json(errorBody("insufficient_scope", "This key lacks the applications:read scope."), 403, requestId);
        }
        return await listApplications(service, req, auth.partnerId, auth.livemode, requestId);
      }
      if (req.method !== "POST") {
        return json(errorBody("method_not_allowed", "Use GET or POST."), 405, requestId, { Allow: "GET, POST" });
      }
      if (!hasScope(auth, "applications:write")) {
        return json(errorBody("insufficient_scope", "This key lacks the applications:write scope."), 403, requestId);
      }
      return await postApplication(
        service, req, auth.partnerId, auth.livemode, auth.apiKeyId, auth.scopes, partner.referencing_mode, requestId,
      );
    }

    if (endpoint.startsWith("applications/")) {
      if (req.method !== "GET") {
        return json(errorBody("method_not_allowed", "Use GET."), 405, requestId, { Allow: "GET" });
      }
      if (!hasScope(auth, "applications:read")) {
        return json(errorBody("insufficient_scope", "This key lacks the applications:read scope."), 403, requestId);
      }
      return await getApplication(
        service, auth.partnerId, auth.livemode, endpoint.slice("applications/".length), requestId,
      );
    }

    if (endpoint === "webhook-endpoints") {
      if (!hasScope(auth, "webhooks:manage")) {
        return json(errorBody("insufficient_scope", "This key lacks the webhooks:manage scope."), 403, requestId);
      }
      if (req.method === "GET") return await listWebhookEndpoints(service, auth.partnerId, auth.livemode, requestId);
      if (req.method === "POST") return await createWebhookEndpoint(service, req, auth.partnerId, auth.livemode, requestId);
      return json(errorBody("method_not_allowed", "Use GET or POST."), 405, requestId, { Allow: "GET, POST" });
    }

    if (endpoint.startsWith("webhook-endpoints/")) {
      if (!hasScope(auth, "webhooks:manage")) {
        return json(errorBody("insufficient_scope", "This key lacks the webhooks:manage scope."), 403, requestId);
      }
      if (req.method !== "DELETE") {
        return json(errorBody("method_not_allowed", "Use DELETE."), 405, requestId, { Allow: "DELETE" });
      }
      return await deleteWebhookEndpoint(service, auth.partnerId, auth.livemode, endpoint.slice("webhook-endpoints/".length), requestId);
    }

    return json(errorBody("not_found", "Unknown endpoint."), 404, requestId);
  } catch (e) {
    // Never leak internals. The request id is the only handle, and it ties to
    // the server-side log line.
    console.log(JSON.stringify({ requestId, event: "unhandled_error", message: String(e) }));
    return json(errorBody("internal_error", "Something went wrong."), 500, requestId);
  }
  };

  // Cloned BEFORE run(), because run() consumes the body. Cloning afterwards
  // returns a request whose stream is already drained, which yields an empty
  // string rather than an error, so the log would quietly show every POST as
  // having sent nothing.
  const res = await run();

  // One log per request, whatever route it took. The body is cloned rather than
  // read, so consuming it here cannot starve the response the caller receives.
  if (logService) {
    let errorCode: string | null = null;
    if (res.status >= 400) {
      try { errorCode = codeOf(await res.clone().json()); } catch { /* not JSON */ }
    }

    // Redacted here, before the insert, so the unredacted value never reaches
    // Postgres, the WAL or a backup. See _shared/redact.ts.
    const [requestBody, responseBody] = await Promise.all([
      reqForLog ? bodyForLog(reqForLog) : Promise.resolve(null),
      bodyForLog(res.clone()),
    ]);

    logRequest(logService, {
      partnerId: logPartnerId, apiKeyId: logKeyId,
      method: req.method, path: logPath,
      status: res.status, errorCode, startedAt,
      requestBody, responseBody,
    });
  }

  // Attached to EVERY response, not just 429s. A partner who only learns their
  // remaining budget when they are refused cannot self-regulate; that is the
  // whole point of the headers. Applied here rather than in json() so no handler
  // has to remember to pass them, which is the version that goes wrong.
  //
  // res.body is still unread: the logging above clones rather than consuming.
  if (Object.keys(rateHeaders).length) {
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(rateHeaders)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }

  return res;
});

/**
 * GET /orgs
 *
 * Agencies and branches for this partner, so the partner can store IDs and stop
 * sending names. has_agent_contact means a deed can be issued: see the migration
 * header for why that is not the same as a contact row existing.
 */
// deno-lint-ignore no-explicit-any
// livemode is not a parameter here any more. Orgs are not per mode: a sandbox
// application references the partner's real branch, so a sandbox key must be able
// to see and name it. Filtering would have returned an empty list to every
// sandbox key with no explanation.
async function getOrgs(service: any, partnerId: string, requestId: string): Promise<Response> {
  const { data: rows, error } = await service.rpc("partner_api_orgs", { p_partner: partnerId });

  if (error) {
    console.log(JSON.stringify({ requestId, event: "orgs_query_failed", message: error.message }));
    return json(errorBody("internal_error", "Something went wrong."), 500, requestId);
  }

  // Flat rows to nested agencies. An agency with no branches arrives as a single
  // row with a null branch_id.
  const byAgency = new Map<string, {
    id: string;
    name: string;
    has_agent_contact: boolean;
    branches: { id: string; name: string; has_agent_contact: boolean }[];
  }>();

  for (const r of rows ?? []) {
    let agency = byAgency.get(r.agency_id);
    if (!agency) {
      agency = {
        id: r.agency_id,
        name: r.agency_name,
        has_agent_contact: r.agency_has_agent_contact === true,
        branches: [],
      };
      byAgency.set(r.agency_id, agency);
    }
    if (r.branch_id) {
      agency.branches.push({
        id: r.branch_id,
        name: r.branch_name,
        has_agent_contact: r.branch_has_agent_contact === true,
      });
    }
  }

  // Explicit field list, never a row passthrough. Section 10 of the spec is
  // default-deny: partner_id, review_state, created_by and every other internal
  // column stay out by construction rather than by remembering to strip them.
  return json({ agencies: Array.from(byAgency.values()) }, 200, requestId);
}

/**
 * POST /applications
 *
 * The idempotency claim is the first thing that happens and the recorded
 * response is the last, so a retry can never double-create. See
 * PARTNER-API.md section 11 for why this matters more here than on the form:
 * retrying after a timeout is normal client behaviour, and without this a
 * network blip bills a tenant twice.
 */
// deno-lint-ignore no-explicit-any
async function postApplication(
  // deno-lint-ignore no-explicit-any
  service: any,
  req: Request,
  partnerId: string,
  livemode: boolean,
  apiKeyId: string,
  scopes: string[],
  mode: string,
  requestId: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(errorBody("malformed_request", "Body must be valid JSON."), 400, requestId);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(errorBody("malformed_request", "Body must be a JSON object."), 400, requestId);
  }

  const idemKey = req.headers.get("Idempotency-Key")?.trim() ||
    (typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "");

  if (!idemKey) {
    return json(
      errorBody("malformed_request", "An Idempotency-Key header or idempotency_key field is required."),
      400,
      requestId,
    );
  }

  const hash = await requestHash(body);

  // ---- claim the key ------------------------------------------------------
  // The unique index on (partner_id, endpoint, idempotency_key) is what makes
  // this a claim rather than a check-then-act: two concurrent retries race here
  // and exactly one wins.
  const { data: claim, error: claimErr } = await service
    .from("partner_api_requests")
    .insert({
      partner_id: partnerId,
      api_key_id: apiKeyId,
      idempotency_key: idemKey,
      endpoint: "POST /applications",
      // Part of the unique key, so a sandbox rehearsal and a live request can
      // share an Idempotency-Key without either replaying the other.
      livemode,
      request_hash: hash,
    })
    .select("id")
    .maybeSingle();

  if (claimErr) {
    // 23505 is the unique violation: this key has been seen before.
    if (claimErr.code !== "23505") {
      console.log(JSON.stringify({ requestId, event: "idem_claim_failed", message: claimErr.message }));
      return json(errorBody("internal_error", "Something went wrong."), 500, requestId);
    }

    const { data: prior } = await service
      .from("partner_api_requests")
      .select("request_hash, status_code, response_body")
      .eq("partner_id", partnerId)
      .eq("livemode", livemode)
      .eq("endpoint", "POST /applications")
      .eq("idempotency_key", idemKey)
      .maybeSingle();

    if (!prior) return json(errorBody("internal_error", "Something went wrong."), 500, requestId);

    // Same key, different body. Almost always a client bug: a key reused for a
    // genuinely different application. Returning the first application's details
    // would be worse than an error, because it would look like success.
    if (prior.request_hash !== hash) {
      return json(
        errorBody("idempotency_key_reused", "This idempotency key was used for a different request."),
        409,
        requestId,
      );
    }

    // Same key, same body, still running.
    if (prior.status_code === null) {
      return json(errorBody("request_in_progress", "This request is still being processed."), 409, requestId, {
        "Retry-After": "2",
      });
    }

    // Genuine retry: replay the stored response verbatim.
    return json(prior.response_body, prior.status_code, requestId, { "Idempotent-Replay": "true" });
  }

  // ---- do the work --------------------------------------------------------
  let outcome;
  try {
    // The key is threaded through so an agency this call creates is audited
    // with the key's own name rather than as an anonymous write.
    outcome = await createApplication(service, partnerId, livemode, scopes, mode, body, apiKeyId);
  } catch (e) {
    console.log(JSON.stringify({ requestId, event: "create_failed", message: String(e) }));
    outcome = { status: 500, body: errorBody("internal_error", "Something went wrong.") };
  }

  // ---- record it ----------------------------------------------------------
  // Failures are recorded too. A retry of a request that failed validation must
  // replay that failure rather than re-running it, or the key means nothing.
  await service
    .from("partner_api_requests")
    .update({
      status_code: outcome.status,
      response_body: outcome.body,
      application_id: outcome.applicationId ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", claim!.id);

  return json(outcome.body, outcome.status, requestId);
}

/**
 * GET /webhook-endpoints
 *
 * The secret is NEVER returned. It is shown once at registration and is not
 * retrievable, the same posture as an API key: a listing endpoint that returns
 * signing secrets turns any read-scoped leak into a forgery capability.
 */
// deno-lint-ignore no-explicit-any
async function listWebhookEndpoints(service: any, partnerId: string, livemode: boolean, requestId: string): Promise<Response> {
  const { data, error } = await service
    .from("partner_webhook_endpoints")
    .select("id, url, events, active, description, created_at, last_success_at, last_failure_at, consecutive_failures")
    .eq("partner_id", partnerId)
    // A sandbox key lists sandbox endpoints and a live key lists live ones. Two
    // separate registries, deliberately: a partner rehearsing retries by pointing
    // an endpoint at a broken URL must not be able to do that to their live one.
    .eq("livemode", livemode)
    .order("created_at", { ascending: false });

  if (error) {
    console.log(JSON.stringify({ requestId, event: "webhook_list_failed", message: error.message }));
    return json(errorBody("internal_error", "Something went wrong."), 500, requestId);
  }

  return json({ endpoints: data ?? [] }, 200, requestId);
}

/**
 * POST /webhook-endpoints
 *
 * Returns the signing secret exactly once. Partners must store it at this point
 * or register a new endpoint.
 */
// deno-lint-ignore no-explicit-any
async function createWebhookEndpoint(service: any, req: Request, partnerId: string, livemode: boolean, requestId: string): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(errorBody("malformed_request", "Body must be valid JSON."), 400, requestId);
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const fields: { field: string; code: string; message: string }[] = [];

  // https only. The payload carries tenant PII and the signature; over plain
  // http both are readable in transit. The database enforces this too, but a
  // field error is a better answer than a constraint violation.
  if (!url) {
    fields.push({ field: "url", code: "required", message: "A url is required." });
  } else if (!url.startsWith("https://")) {
    fields.push({ field: "url", code: "must_be_https", message: "The url must use https." });
  }

  const events = Array.isArray(body.events) ? body.events.filter((e) => typeof e === "string") as string[] : [];
  const KNOWN = [
    "application.created", "application.paid", "application.deed_issued",
    "application.lapsed", "application.withdrawn", "application.reinstated",
  ];
  for (const e of events) {
    if (!KNOWN.includes(e)) {
      fields.push({ field: "events", code: "unknown_event", message: `Unknown event type: ${e}` });
    }
  }

  if (fields.length > 0) {
    return json(
      { error: { code: "validation_failed", message: "The endpoint was not created.", fields } },
      422,
      requestId,
    );
  }

  const secret = generateEndpointSecret();

  const { data, error } = await service
    .from("partner_webhook_endpoints")
    .insert({
      partner_id: partnerId,
      // From the key, never from the body. The request has no say in this.
      livemode,
      url,
      secret,
      events,
      description: typeof body.description === "string" ? body.description.trim() : null,
    })
    .select("id, url, events, active, created_at")
    .maybeSingle();

  if (error) {
    console.log(JSON.stringify({ requestId, event: "webhook_create_failed", message: error.message }));
    return json(errorBody("internal_error", "Something went wrong."), 500, requestId);
  }

  return json({ endpoint: data, secret }, 201, requestId);
}

/** DELETE /webhook-endpoints/{id}. Scoped to the caller's partner. */
// deno-lint-ignore no-explicit-any
async function deleteWebhookEndpoint(service: any, partnerId: string, livemode: boolean, id: string, requestId: string): Promise<Response> {
  const { data, error } = await service
    .from("partner_webhook_endpoints")
    .delete()
    .eq("id", id)
    .eq("partner_id", partnerId)   // never delete another partner's endpoint
    .eq("livemode", livemode)      // and a sandbox key never deletes a live one
    .select("id")
    .maybeSingle();

  if (error) {
    console.log(JSON.stringify({ requestId, event: "webhook_delete_failed", message: error.message }));
    return json(errorBody("internal_error", "Something went wrong."), 500, requestId);
  }
  // Same answer whether it does not exist or belongs to another partner.
  if (!data) return json(errorBody("not_found", "Unknown endpoint."), 404, requestId);

  return new Response(null, { status: 204, headers: { ...cors, "X-Request-Id": requestId } });
}

/**
 * GET /applications/{id}
 *
 * Includes payment_url, because a partner fetching one application is acting on
 * it. The list endpoint deliberately does not: see partnerViews.ts.
 */
// deno-lint-ignore no-explicit-any
async function getApplication(service: any, partnerId: string, livemode: boolean, id: string, requestId: string): Promise<Response> {
  // A malformed id must not reach the RPC as a cast error. Same answer as a
  // genuine miss, so the shape of an id is not a probe either.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return json(errorBody("not_found", "Unknown application."), 404, requestId);
  }

  const { data, error } = await service.rpc("partner_api_applications", {
    p_partner: partnerId,
    p_livemode: livemode,
    p_id: id,
    p_status: null,
    p_limit: 1,
    p_cursor_created_at: null,
    p_cursor_id: null,
  });

  if (error) {
    console.log(JSON.stringify({ requestId, event: "application_read_failed", message: error.message }));
    return json(errorBody("internal_error", "Something went wrong."), 500, requestId);
  }

  const rows = (data ?? []) as ApplicationRow[];
  // The RPC filters on partner_id, so another partner's application returns no
  // rows and is indistinguishable from one that does not exist.
  if (rows.length === 0) {
    // THE RESPONSE IS UNCHANGED. What follows never alters what the caller sees:
    // same status, same body. It only decides whether WE hear about it.
    //
    // A well-formed uuid that misses is either a genuinely unknown id, which is
    // ordinary, or one belonging to another partner, which is not. Distinguishing
    // them requires a lookup the caller cannot see the result of, which is
    // exactly what service_role is for here.
    //
    // Worth being clear about why this is not paranoia: application ids are
    // returned in our own API responses and webhook payloads, so a partner who
    // integrates with two systems, or a developer testing with a colleague's
    // copied id, can hold one legitimately. One attempt is a mistake. A pattern
    // is the thing we want to see, and the aggregation in record_security_event
    // is what turns the second into a single row that counts up.
    await crossPartnerCheck(service, "application", id, partnerId, requestId);
    return json(errorBody("not_found", "Unknown application."), 404, requestId);
  }

  return json(
    { application: applicationView(rows[0], { appUrl: Deno.env.get("APP_URL") ?? "", includePaymentUrl: true }) },
    200,
    requestId,
  );
}

/**
 * GET /applications
 *
 * Keyset paginated, newest first. `next_cursor` is null on the last page, which
 * is the termination signal: a client loops until it is null rather than
 * counting pages.
 */
// deno-lint-ignore no-explicit-any
async function listApplications(service: any, req: Request, partnerId: string, livemode: boolean, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;

  // Filter by the PARTNER-FACING status, so a caller filters with the same
  // vocabulary the responses use. 'lapsed' in, 'expired' to the query.
  const partnerStatus = url.searchParams.get("status");
  const INTERNAL: Record<string, string> = {
    sent: "sent", paid: "paid", deed_issued: "deed", withdrawn: "withdrawn", lapsed: "expired",
  };
  let status: string | null = null;
  if (partnerStatus) {
    if (!(partnerStatus in INTERNAL)) {
      return json(
        {
          error: {
            code: "validation_failed",
            message: "Unknown status filter.",
            fields: [{
              field: "status",
              code: "unknown_value",
              message: `status must be one of ${Object.keys(INTERNAL).join(", ")}`,
            }],
          },
        },
        422,
        requestId,
      );
    }
    status = INTERNAL[partnerStatus];
  }

  const rawCursor = url.searchParams.get("cursor");
  let cursor: { createdAt: string; id: string } | null = null;
  if (rawCursor) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) {
      return json(errorBody("malformed_request", "The cursor is not valid."), 400, requestId);
    }
  }

  // Ask for one more than requested. If it comes back there is another page,
  // which avoids a second count query purely to decide whether to paginate.
  const { data, error } = await service.rpc("partner_api_applications", {
    p_partner: partnerId,
    p_livemode: livemode,
    p_id: null,
    p_status: status,
    p_limit: limit + 1,
    p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null,
  });

  if (error) {
    console.log(JSON.stringify({ requestId, event: "application_list_failed", message: error.message }));
    return json(errorBody("internal_error", "Something went wrong."), 500, requestId);
  }

  const rows = (data ?? []) as ApplicationRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return json(
    {
      applications: page.map((r) => applicationView(r)),
      next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    },
    200,
    requestId,
  );
}
