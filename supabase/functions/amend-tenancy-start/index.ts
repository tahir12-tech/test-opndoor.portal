// =====================================================================
// amend-tenancy-start (verify_jwt = true)
//
// Single server entry point for amending the tenancy start date. Permission is
// enforced by the amend_tenancy_start RPC (deed-state aware, AAL2, ownership),
// called as the signed-in user. After the date update, the deed lifecycle and its
// activity trail are the shared reissueDeedForAmendment helper, run with the
// service role, so this staff path and the agent self-serve path
// (tenancy-correction) cannot drift apart.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { isExecutedDeed, reissueDeedForAmendment } from "../_shared/deedReissue.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** yyyy-mm-dd (or ISO) -> dd/mm/yyyy for the activity message. */
function dmy(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso ?? "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ ok: false, error: "Not authenticated." }, 401);

    const { ref, newStart, confirmReissue } = await req.json();
    if (!ref || !newStart) return json({ ok: false, error: "Missing application reference or new start date." }, 400);

    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    let actor = "A user";
    if (userData.user?.id) {
      const { data: prof } = await userClient.from("users").select("full_name").eq("id", userData.user.id).maybeSingle();
      if (prof?.full_name) actor = prof.full_name;
    }

    // RLS-scoped read of the pre-amend state (drives the deed orchestration and
    // gives the OLD tenancy start for the activity message).
    const { data: app, error: readErr } = await userClient
      .from("applications")
      .select("id, guarantee_ref, status, deed_state, pandadoc_document_id, executed_pdf_path, tenancy_start")
      .eq("guarantee_ref", ref)
      .maybeSingle();
    if (readErr) return json({ ok: false, error: readErr.message }, 400);
    if (!app) return json({ ok: false, error: "Application not found, or you do not have access to it." }, 404);

    const oldDmy = dmy(app.tenancy_start);
    const newDmy = dmy(newStart);
    const dateChange = `from ${oldDmy} to ${newDmy}`;

    // #82 Amending a SIGNED (executed) deed is destructive: it voids/supersedes the
    // signed deed, reissues it to the tenant, and re-notifies the agent once
    // re-signed. Require an explicit confirmation BEFORE the date is committed.
    if (isExecutedDeed(app) && confirmReissue !== true) {
      return json({ ok: false, needsConfirm: true, error: "Amending the tenancy start on a signed deed will void it, reissue a corrected deed to the tenant to sign, and re-notify the agent once re-signed. Confirm to proceed." }, 200);
    }

    // 1) Permission + date update, enforced in the database (deed-state aware).
    const { error: rpcErr } = await userClient.rpc("amend_tenancy_start", { p_app: app.id, p_new_start: newStart });
    if (rpcErr) {
      return json({ ok: false, error: "Could not amend the tenancy start date." }, 200);
    }

    const service = createClient(SUPABASE_URL, SERVICE);

    // #81 The date is now amended, so any agent-reported tenancy-start corrections
    // for this application are handled; mark them resolved (best-effort).
    await service.from("tenancy_correction_tokens")
      .update({ resolved_at: new Date().toISOString(), resolved_by: userData.user?.id ?? null })
      .eq("application_id", app.id).is("resolved_at", null).not("submitted_at", "is", null);

    // 2) Deed lifecycle + the single business amend entry, shared with the agent
    // self-serve path (tenancy-correction) so the two can never drift apart.
    const out = await reissueDeedForAmendment(service, app, actor, dateChange);
    if (!out.ok) return json({ ok: false, error: out.error }, 200);
    return json({ ok: true, message: out.message });
  } catch (e) {
    return json({ ok: false, error: "Could not amend the tenancy start date." }, 500);
  }
});
