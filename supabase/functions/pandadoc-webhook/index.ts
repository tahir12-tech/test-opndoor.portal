// =====================================================================
// pandadoc-webhook (verify_jwt = false)
//
// PandaDoc cannot send a Supabase JWT, so JWT verification is off and security
// is the PandaDoc HMAC signature (PANDADOC_WEBHOOK_SHARED_KEY). Service-role
// transition via apply_deed_executed (the deed twin of apply_stripe_payment).
//
// Idempotent: a document reaching a given status is processed once
// (pandadoc_events). Document completed -> download + store the executed PDF
// and flip Paid to Deed Issued. Voided / declined set the deed sub-state and
// log for review; no status change. Other statuses are acknowledged.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyWebhook, downloadPdf } from "../_shared/pandadoc.ts";

Deno.serve(async (req) => {
  const signature = new URL(req.url).searchParams.get("signature") ?? "";
  const body = await req.text();
  if (!(await verifyWebhook(body, signature))) return new Response("Invalid signature", { status: 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let events: any[];
  try {
    const parsed = JSON.parse(body);
    events = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return new Response("Bad body", { status: 400 });
  }

  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  for (const ev of events) {
    const docId = ev?.data?.id;
    const status = ev?.data?.status;
    const type = ev?.event ?? ev?.event_type ?? "unknown";
    if (!docId) continue;

    const evId = `${docId}:${status ?? type}`;
    const { error: insErr } = await service.from("pandadoc_events").insert({ id: evId, type });
    if (insErr) continue; // duplicate delivery -> skip

    const { data: app } = await service.from("applications").select("id, guarantee_ref").eq("pandadoc_document_id", docId).maybeSingle();

    if (status === "document.completed") {
      let path: string | null = null;
      const pdf = await downloadPdf(docId);
      if (pdf && app) {
        path = `${app.id}/${app.guarantee_ref}.pdf`;
        await service.storage.from("deeds").upload(path, pdf, { contentType: "application/pdf", upsert: true });
      }
      await service.rpc("apply_deed_executed", { p_document_id: docId, p_pdf_path: path });
      if (app) {
        // The signing event. The "Deed Issued" milestone (status/timeline) is
        // driven by apply_deed_executed above; this is the distinct signed entry.
        await service.from("activity_log").insert({ application_id: app.id, kind: "deed_signed", message: "Deed signed by the tenant.", actor: "PandaDoc", visibility: "business" });
        await service.from("pandadoc_events").update({ application_id: app.id }).eq("id", evId);
      }
    } else if (status === "document.viewed") {
      if (app) {
        // First view only: the event id (docId:document.viewed) is deduplicated
        // above, and the null guard is a second safeguard.
        await service.from("applications").update({ deed_viewed_at: new Date().toISOString() }).eq("id", app.id).is("deed_viewed_at", null);
        await service.from("activity_log").insert({ application_id: app.id, kind: "deed_viewed", message: "Deed viewed by the tenant.", actor: "PandaDoc", visibility: "business" });
        await service.from("pandadoc_events").update({ application_id: app.id }).eq("id", evId);
      }
    } else if (status === "document.voided") {
      await service.rpc("set_deed_state", { p_document_id: docId, p_state: "voided" });
      if (app) await service.from("activity_log").insert({ application_id: app.id, kind: "deed_voided", message: "Deed document voided in PandaDoc. Review required.", actor: "PandaDoc" });
    } else if (status === "document.declined") {
      await service.rpc("set_deed_state", { p_document_id: docId, p_state: "declined" });
      if (app) await service.from("activity_log").insert({ application_id: app.id, kind: "deed_declined", message: "Tenant declined to sign the deed. Review required.", actor: "PandaDoc" });
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
