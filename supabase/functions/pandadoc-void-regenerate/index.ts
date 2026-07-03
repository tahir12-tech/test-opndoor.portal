// =====================================================================
// pandadoc-void-regenerate (verify_jwt = true)
//
// Management / opndoor admin only. Voids the outstanding PandaDoc document
// (needed when it was generated from a broken template or with wrong details),
// clears the link, then generates a fresh deed from the current template. Both
// steps are logged to the activity feed.
//
// Zombie-safety: apply_deed_executed / set_deed_state both match on
// pandadoc_document_id. Clearing the id before regeneration means any later
// event for the old document finds no row and is inert (no flip to Deed Issued).
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

    const { ref } = await req.json();
    if (!ref) return json({ ok: false, error: "Missing application reference." }, 400);

    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    let actor = "A user";
    let role = "";
    if (userData.user?.id) {
      const { data: prof } = await userClient.from("users").select("full_name, role").eq("id", userData.user.id).maybeSingle();
      if (prof?.full_name) actor = prof.full_name;
      role = prof?.role ?? "";
    }
    // Destructive action: Management and opndoor admin only (not Referrers).
    if (role !== "management" && role !== "superadmin") {
      return json({ ok: false, error: "Only Management or opndoor admin can void and regenerate a deed." }, 403);
    }

    // RLS-scoped read: the caller must be able to see the application.
    const { data: app, error } = await userClient
      .from("applications")
      .select("id, status, deed_state, pandadoc_document_id")
      .eq("guarantee_ref", ref)
      .maybeSingle();
    if (error) return json({ ok: false, error: error.message }, 400);
    if (!app) return json({ ok: false, error: "Application not found, or you do not have access to it." }, 404);
    if (app.status !== "paid") return json({ ok: false, error: "A deed can only be voided and regenerated while the application is Paid and awaiting execution." }, 400);

    const service = createClient(SUPABASE_URL, SERVICE);

    // Step 1: void the outstanding document (if any) and log it.
    if (app.pandadoc_document_id) {
      const voided = await voidDocument(app.pandadoc_document_id);
      if (!voided.ok) return json({ ok: false, error: `Could not void the outstanding deed: ${voided.error}` }, 200);
      const note = voided.alreadyGone ? "was already closed in PandaDoc" : "voided in PandaDoc";
      await service.from("activity_log").insert({
        application_id: app.id,
        kind: "deed_voided",
        message: `Outstanding deed document ${note} by ${actor} (superseded).`,
        actor,
      });
      // Clear the link before regenerating so any stray event for the old document is inert.
      await service.from("applications").update({ pandadoc_document_id: null, deed_state: null }).eq("id", app.id);
    }

    // Step 2: generate a fresh deed from the current template (logs deed_sent itself).
    const gen = await generateDeed(service, app.id);
    if (!gen.ok) return json({ ok: false, error: `Old document voided, but the fresh deed failed: ${gen.error}` }, 200);
    await service.from("activity_log").insert({
      application_id: app.id,
      kind: "deed_regenerated",
      message: `Fresh deed generated from the current template and sent to the tenant by ${actor}.`,
      actor,
    });
    return json({ ok: true, message: "Old deed voided and a fresh deed sent to the tenant to sign." });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
