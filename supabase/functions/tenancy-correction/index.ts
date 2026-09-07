// =====================================================================
// tenancy-correction (verify_jwt = false)
//
// Public token exchange for #81. An agent opens the tokenised link from the deed
// delivery email, sees the guarantee reference and the current tenancy start, and
// submits the corrected date with an optional note.
//
// Submitting APPLIES the correction straight away, with no manual review step:
// the tenancy start is written, the existing agreement is cancelled (a signed deed
// is archived and superseded; an outstanding unsigned one is voided) and a
// corrected deed is issued to the tenant to sign. The agent is re-notified
// automatically when the replacement is executed, by the usual deed-delivery path.
//
// The deed lifecycle and its activity trail are the shared reissueDeedForAmendment
// helper, the same code the staff amend flow runs, so the two cannot drift apart.
//
// The token is a random uuid scoped to one deed, expiring 7 days after the deed
// was delivered (the same lifetime as the signed download link), and is single
// use: once submitted it will not amend again.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { reissueDeedForAmendment } from "../_shared/deedReissue.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** yyyy-mm-dd (or ISO) -> dd/mm/yyyy for display. */
function dmy(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso ?? "");
}

/** Same range guard the amend_tenancy_start RPC applies on the staff path. */
function outOfRange(isoDate: string): boolean {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(t)) return true;
  const fiveYears = Date.now() + 5 * 365.25 * 24 * 60 * 60 * 1000;
  return t < Date.parse("2000-01-01T00:00:00Z") || t > fiveYears;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const b = await req.json().catch(() => ({}));
    const token = String(b.token ?? "").trim();
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return json({ ok: false, error: "This link is not valid." }, 200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tok } = await service.from("tenancy_correction_tokens")
      .select("token, application_id, guarantee_ref, expires_at, submitted_at, applications(id, guarantee_ref, status, deed_state, pandadoc_document_id, executed_pdf_path, payment_state, withdrawn_at, tenancy_start, prop_addr1, prop_postcode)")
      .eq("token", token).maybeSingle() as { data: any };
    if (!tok) return json({ ok: false, error: "This link is not valid." }, 200);
    if (new Date(tok.expires_at).getTime() < Date.now()) return json({ ok: false, expired: true, error: "This link has expired." }, 200);

    const app = Array.isArray(tok.applications) ? tok.applications[0] : tok.applications;
    const property = [app?.prop_addr1, app?.prop_postcode].filter(Boolean).join(", ");

    if (b.action === "load") {
      return json({ ok: true, guaranteeRef: tok.guarantee_ref, currentStart: dmy(app?.tenancy_start ?? null), property, alreadySubmitted: !!tok.submitted_at });
    }

    if (b.action === "submit") {
      const proposed = String(b.proposedStart ?? "").trim(); // yyyy-mm-dd
      if (!/^\d{4}-\d{2}-\d{2}$/.test(proposed) || outOfRange(proposed)) return json({ ok: false, error: "Enter a valid date." }, 200);
      const note = String(b.note ?? "").trim().slice(0, 500) || null;
      // Single use: a token that already amended must not amend again, so a stray
      // re-submit can never trigger a second cancel-and-reissue cycle.
      if (tok.submitted_at) return json({ ok: false, alreadySubmitted: true, error: "This correction has already been submitted." }, 200);
      if (!app) return json({ ok: false, error: "This link is not valid." }, 200);
      // Terminal applications are out of scope for a self-serve amend: record the
      // report for opndoor instead of cancelling and reissuing anything.
      const terminal = app.status === "withdrawn" || !!app.withdrawn_at || app.payment_state === "refunded";
      const oldStart = app.tenancy_start ?? null;
      if (proposed === oldStart) return json({ ok: false, error: "That is already the tenancy start date on the deed." }, 200);

      const nowIso = new Date().toISOString();
      // The submission is recorded either way. When it is applied automatically it
      // is resolved in the same write, so it never enters the review queue.
      await service.from("tenancy_correction_tokens").update({
        proposed_start: proposed, note, submitted_at: nowIso,
        resolved_at: terminal ? null : nowIso, resolved_by: null,
      }).eq("token", token);

      if (terminal) {
        await service.from("activity_log").insert({
          application_id: tok.application_id,
          kind: "tenancy_correction_reported",
          message: `${tok.guarantee_ref}: agent reports the tenancy start should be ${dmy(proposed)}${note ? ` (note: ${note})` : ""}. Not applied automatically because this application is withdrawn or refunded; review manually.`,
          actor: "Agent", visibility: "internal",
        });
        return json({ ok: true, applied: false });
      }

      // Audit that the agent used the link, with their note; the amend itself is the
      // single business tenancy_amended entry written by the shared helper below.
      await service.from("activity_log").insert({
        application_id: tok.application_id,
        kind: "tenancy_correction_reported",
        message: `${tok.guarantee_ref}: agent corrected the tenancy start to ${dmy(proposed)} from the deed email link${note ? ` (note: ${note})` : ""}.`,
        actor: "Agent", visibility: "internal",
      });

      // Commit the date, then cancel the existing agreement and reissue.
      const { error: updErr } = await service.from("applications").update({ tenancy_start: proposed }).eq("id", app.id);
      if (updErr) return json({ ok: false, error: "Could not apply the correction. Please reply to the deed email." }, 200);

      const dateChange = `from ${dmy(oldStart)} to ${dmy(proposed)}`;
      const out = await reissueDeedForAmendment(service, app, "Agent", dateChange, "the letting agent");
      if (!out.ok) {
        // The date stands but no replacement went out; opndoor must pick this up, so
        // reopen the report in the needs-attention queue.
        await service.from("tenancy_correction_tokens").update({ resolved_at: null }).eq("token", token);
        return json({ ok: false, applied: true, reissued: false, error: "The date has been corrected, but the replacement deed could not be issued automatically. opndoor has been notified and will be in touch." }, 200);
      }
      return json({ ok: true, applied: true, reissued: true });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (e) {
    return json({ ok: false, error: "Could not submit the tenancy correction." }, 500);
  }
});
