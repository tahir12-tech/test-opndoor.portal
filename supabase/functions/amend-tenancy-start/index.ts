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
    if ((app.deed_state === "executed" || app.status === "deed") && confirmReissue !== true) {
      return json({ ok: false, needsConfirm: true, error: "Amending the tenancy start on a signed deed will void it, reissue a corrected deed to the tenant to sign, and re-notify the agent once re-signed. Confirm to proceed." }, 200);
    }

    // 1) Permission + date update, enforced in the database (deed-state aware).
    const { error: rpcErr } = await userClient.rpc("amend_tenancy_start", { p_app: app.id, p_new_start: newStart });
    if (rpcErr) return json({ ok: false, error: rpcErr.message }, 200);

    const service = createClient(SUPABASE_URL, SERVICE);

    // #81 The date is now amended, so any agent-reported tenancy-start corrections
    // for this application are handled; mark them resolved (best-effort).
    await service.from("tenancy_correction_tokens")
      .update({ resolved_at: new Date().toISOString(), resolved_by: userData.user?.id ?? null })
      .eq("application_id", app.id).is("resolved_at", null).not("submitted_at", "is", null);

    // Exactly one BUSINESS activity entry per amend, attributed by name, stating
    // old -> new. "The deed was reissued for signing" is appended ONLY when a
    // regeneration actually ran. Supporting steps (archive / void) are separate:
    // the archive entry references the amend; the void is an internal detail.
    const logAmend = (suffix: string) =>
      service.from("activity_log").insert({
        application_id: app.id, kind: "tenancy_amended",
        message: `Tenancy start amended ${dateChange} by ${actor}.${suffix}`,
        actor, visibility: "business",
      });

    // 2) Deed lifecycle, keyed on the state at amend time.
    if (app.deed_state === "executed" || app.status === "deed") {
      // Archive the signed PDF before replacing it (the entry references the amend).
      // Only claim an archive when there actually was a stored PDF to archive.
      const archived = !!app.executed_pdf_path;
      if (archived) {
        const archivePath = `${app.id}/archive/${app.guarantee_ref}-superseded-${app.pandadoc_document_id ?? "deed"}.pdf`;
        await service.storage.from("deeds").copy(app.executed_pdf_path, archivePath);
        await service.from("activity_log").insert({ application_id: app.id, kind: "deed_archived", message: `Signed deed archived before amending the tenancy start ${dateChange}, by ${actor}.`, actor, visibility: "business" });
      }
      const archivePhrase = archived ? "The signed deed was archived and a" : "A";
      // Reopen to Paid and clear the executed deed, then issue a replacement.
      await service.from("applications").update({
        status: "paid", deed_state: null, deed_issued_at: null, deed_executed_at: null,
        issue_date: null, executed_pdf_path: null, pandadoc_document_id: null, deed_viewed_at: null,
      }).eq("id", app.id);
      const gen = await generateDeed(service, app.id, true);
      if (!gen.ok) {
        // The date change already committed: always leave exactly one amend entry,
        // without a reissue clause (no regeneration ran).
        await logAmend(`${archived ? " The signed deed was archived." : ""} The replacement deed could not be issued automatically; opndoor has been notified.`);
        return json({ ok: false, error: `Tenancy start amended${archived ? " and the signed deed archived" : ""}, but the replacement failed: ${gen.error}` }, 200);
      }
      await logAmend(` ${archivePhrase} replacement was reissued for signing.`);
      return json({ ok: true, message: `Tenancy start amended.${archived ? " The signed deed was archived and a replacement" : " A replacement deed was"} sent to the tenant to sign.` });
    }

    if (app.deed_state === "awaiting_tenant" && app.pandadoc_document_id) {
      // #82 one-live-deed invariant: the outstanding unsigned deed must ALWAYS be
      // replaced with a corrected one so the deed and the amended date can never
      // disagree. The void of the old PandaDoc envelope is BEST-EFFORT: clear the
      // document id first (so any late webhook for the old document is inert), then
      // attempt the void, then regenerate regardless of the void outcome. A failed
      // void never blocks the amend, because the new deed supersedes the old one.
      const oldDocId = app.pandadoc_document_id;
      await service.from("applications").update({ pandadoc_document_id: null, deed_state: null, deed_viewed_at: null }).eq("id", app.id);
      const voided = await voidDocument(oldDocId);
      await service.from("activity_log").insert({
        application_id: app.id, kind: "deed_voided",
        message: voided.ok
          ? `Outstanding deed voided for a tenancy-start amendment ${dateChange} by ${actor}.`
          : `Outstanding deed could not be voided for a tenancy-start amendment ${dateChange}; it is superseded by the regenerated deed. Detail: ${voided.error}`,
        actor, visibility: "internal",
      });
      const gen = await generateDeed(service, app.id, true);
      if (!gen.ok) {
        // Date change committed; the deed is left in 'error' (not live) so the
        // invariant still holds. Log the amend without a reissue clause.
        await logAmend(" The corrected deed could not be issued automatically; opndoor has been notified.");
        return json({ ok: false, error: `Tenancy start amended, but the corrected deed failed: ${gen.error}` }, 200);
      }
      // Audit line the ruling requires, kept as an INTERNAL supporting step so the
      // single business tenancy_amended entry (below) is the only partner-visible
      // row, matching the executed branch and the one-business-entry-per-amend rule.
      await service.from("activity_log").insert({ application_id: app.id, kind: "deed_regenerated", message: "Deed regenerated after tenancy amendment.", actor, visibility: "internal" });
      await logAmend(" The outstanding deed was replaced with a corrected one for signing.");
      return json({ ok: true, message: "Tenancy start amended. The outstanding deed was replaced with a corrected one." });
    }

    // Sent, or Paid with no live deed (error / declined / voided / none): no reissue.
    await logAmend("");
    return json({ ok: true, message: "Tenancy start amended." });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
