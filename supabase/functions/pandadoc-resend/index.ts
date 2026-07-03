// =====================================================================
// pandadoc-resend (verify_jwt = true)
//
// Manual "Resend signature request" for owning Referrer / Management / admin
// (enforced by RLS on the caller-scoped read). If the deed is awaiting the
// tenant, it re-sends the existing document; if it errored, was declined or
// voided, it generates a fresh document. Logged to the activity feed.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { remindSignature, generateDeed } from "../_shared/pandadoc.ts";

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
    if (userData.user?.id) {
      const { data: prof } = await userClient.from("users").select("full_name").eq("id", userData.user.id).maybeSingle();
      if (prof?.full_name) actor = prof.full_name;
    }

    const { data: app, error } = await userClient
      .from("applications")
      .select("id, status, deed_state, pandadoc_document_id, guarantee_ref, tenant_first_name, tenant_last_name")
      .eq("guarantee_ref", ref)
      .maybeSingle();
    if (error) return json({ ok: false, error: error.message }, 400);
    if (!app) return json({ ok: false, error: "Application not found, or you do not have access to it." }, 404);
    if (app.status !== "paid") return json({ ok: false, error: "The deed can only be (re)sent while the application is Paid and awaiting execution." }, 400);

    const service = createClient(SUPABASE_URL, SERVICE);
    if (app.deed_state === "awaiting_tenant" && app.pandadoc_document_id) {
      // State-aware nudge: reminder if PandaDoc allows it, else re-deliver the link.
      const result = await remindSignature(app.pandadoc_document_id, {
        guarantee_ref: app.guarantee_ref,
        tenant_first_name: app.tenant_first_name,
        tenant_last_name: app.tenant_last_name,
      });
      if (!result.ok) {
        // Honest, partner-safe entry for everyone; the raw provider detail is
        // logged internal (opndoor-admin-only). No raw error reaches the partner.
        if (result.technical) {
          await service.from("activity_log").insert([
            { application_id: app.id, kind: "deed_reminder_failed", message: result.error, actor: "System", visibility: "business" },
            { application_id: app.id, kind: "deed_reminder_failed", message: `Reminder failed: ${result.technical}`, actor: "System", visibility: "internal" },
          ]);
        }
        return json({ ok: false, error: result.error }, 200);
      }
      const message = result.method === "link" ? "Signing link re-sent to the tenant." : "Signature reminder sent to the tenant.";
      await service.from("activity_log").insert({ application_id: app.id, kind: "deed_reminded", message: `${message} (by ${actor})`, actor });
      return json({ ok: true, message });
    }
    // No live document (errored / declined / voided): generate a fresh one.
    const gen = await generateDeed(service, app.id);
    if (!gen.ok) return json({ ok: false, error: gen.error }, 200);
    return json({ ok: true, message: "Fresh deed sent to the tenant to sign." });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
