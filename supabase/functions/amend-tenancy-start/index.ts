// =====================================================================
// amend-tenancy-start (verify_jwt = true)
//
// Single server entry point for amending the tenancy start date. Permission is
// enforced by the amend_tenancy_start RPC (deed-state aware, AAL2, ownership),
// called as the signed-in user. After the date update, the deed lifecycle is
// orchestrated with the service role, keyed on the deed state at amend time:
//   - awaiting_tenant : void the outstanding document and regenerate, so the
//                       corrected tenancy start prints on a fresh deed;
//   - executed        : archive the signed PDF, reopen to Paid, and issue a
//                       replacement deed for signing (Management/admin only, per
//                       the RPC's permission check);
//   - otherwise (Sent, or Paid with no live deed): the date update alone.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { voidDocument, generateDeed } from "../_shared/pandadoc.ts";

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
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ ok: false, error: "Not authenticated." }, 401);

    const { ref, newStart } = await req.json();
    if (!ref || !newStart) return json({ ok: false, error: "Missing application reference or new start date." }, 400);

    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    let actor = "A user";
    if (userData.user?.id) {
      const { data: prof } = await userClient.from("users").select("full_name").eq("id", userData.user.id).maybeSingle();
      if (prof?.full_name) actor = prof.full_name;
    }

    // RLS-scoped read of the pre-amend state (drives the deed orchestration below).
    const { data: app, error: readErr } = await userClient
      .from("applications")
      .select("id, guarantee_ref, status, deed_state, pandadoc_document_id, executed_pdf_path")
      .eq("guarantee_ref", ref)
      .maybeSingle();
    if (readErr) return json({ ok: false, error: readErr.message }, 400);
    if (!app) return json({ ok: false, error: "Application not found, or you do not have access to it." }, 404);

    // 1) Permission + date update, enforced in the database (deed-state aware).
    const { error: rpcErr } = await userClient.rpc("amend_tenancy_start", { p_app: app.id, p_new_start: newStart });
    if (rpcErr) return json({ ok: false, error: rpcErr.message }, 200);

    const service = createClient(SUPABASE_URL, SERVICE);

    // 2) Deed lifecycle, keyed on the state at amend time.
    if (app.deed_state === "executed" || app.status === "deed") {
      // Archive the signed PDF before replacing it.
      if (app.executed_pdf_path) {
        const archivePath = `${app.id}/archive/${app.guarantee_ref}-superseded-${app.pandadoc_document_id ?? "deed"}.pdf`;
        await service.storage.from("deeds").copy(app.executed_pdf_path, archivePath);
        await service.from("activity_log").insert({ application_id: app.id, kind: "deed_archived", message: `Signed deed archived before amendment by ${actor}.`, actor, visibility: "business" });
      }
      // Reopen to Paid and clear the executed deed, then issue a replacement.
      await service.from("applications").update({
        status: "paid", deed_state: null, deed_issued_at: null, deed_executed_at: null,
        issue_date: null, executed_pdf_path: null, pandadoc_document_id: null, deed_viewed_at: null,
      }).eq("id", app.id);
      const gen = await generateDeed(service, app.id);
      if (!gen.ok) return json({ ok: false, error: `Tenancy start amended and the signed deed archived, but the replacement failed: ${gen.error}` }, 200);
      await service.from("activity_log").insert({ application_id: app.id, kind: "deed_reissued", message: `Tenancy start amended; signed deed archived and a replacement issued for signing by ${actor}.`, actor, visibility: "business" });
      return json({ ok: true, message: "Tenancy start amended. The signed deed was archived and a replacement sent to the tenant to sign." });
    }

    if (app.deed_state === "awaiting_tenant" && app.pandadoc_document_id) {
      // Void the outstanding unsigned document and regenerate with the new date.
      const voided = await voidDocument(app.pandadoc_document_id);
      if (!voided.ok) return json({ ok: false, error: `Tenancy start amended, but voiding the outstanding deed failed: ${voided.error}` }, 200);
      await service.from("applications").update({ pandadoc_document_id: null, deed_state: null, deed_viewed_at: null }).eq("id", app.id);
      await service.from("activity_log").insert({ application_id: app.id, kind: "deed_voided", message: `Outstanding deed voided for a tenancy-start amendment by ${actor}.`, actor, visibility: "business" });
      const gen = await generateDeed(service, app.id);
      if (!gen.ok) return json({ ok: false, error: `Tenancy start amended, but the corrected deed failed: ${gen.error}` }, 200);
      await service.from("activity_log").insert({ application_id: app.id, kind: "deed_regenerated", message: `Corrected deed generated after tenancy-start amendment by ${actor}.`, actor, visibility: "business" });
      return json({ ok: true, message: "Tenancy start amended. The outstanding deed was replaced with a corrected one." });
    }

    // Sent, or Paid with no live deed (error / declined / voided / none).
    await service.from("activity_log").insert({ application_id: app.id, kind: "tenancy_amended", message: `Tenancy start amended by ${actor}.`, actor, visibility: "business" });
    return json({ ok: true, message: "Tenancy start amended." });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
