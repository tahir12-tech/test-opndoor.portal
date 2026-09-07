// =====================================================================
// deed-download (verify_jwt = true)
//
// Returns a short-lived signed URL for the executed deed PDF, scoped by RLS to
// whoever can already see the application (owning Referrer, Management, admin).
// The bucket is private; the service role mints the signed URL.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

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
    const { data: app, error } = await userClient
      .from("applications")
      .select("id, executed_pdf_path")
      .eq("guarantee_ref", ref)
      .maybeSingle();
    if (error) {
      return json({ ok: false, error: "Could not open the deed download." }, 400);
    }
    if (!app) return json({ ok: false, error: "Application not found, or you do not have access to it." }, 404);
    if (!app.executed_pdf_path) return json({ ok: false, error: "The deed has not been issued yet." }, 400);

    const service = createClient(SUPABASE_URL, SERVICE);
    const { data: signed, error: sErr } = await service.storage.from("deeds").createSignedUrl(app.executed_pdf_path, 300);
    if (sErr || !signed) return json({ ok: false, error: "Could not generate the download link." }, 500);
    return json({ ok: true, url: signed.signedUrl });
  } catch (e) {
    return json({ ok: false, error: "Could not open the deed download." }, 500);
  }
});
