// =====================================================================
// tenancy-correction (verify_jwt = false)
//
// Public token exchange for #81. An agent opens the tokenised link from the deed
// delivery email, sees the guarantee reference and the current tenancy start, and
// proposes a corrected date with an optional note. Submitting NEVER writes the
// application: it records the report on the token row (the opndoor needs-attention
// queue) plus an activity_log entry. An opndoor admin reviews and applies the
// change through the existing audited amend flow.
//
// The token is a random uuid scoped to one deed, expiring 7 days after the deed
// was delivered (the same lifetime as the signed download link).
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const b = await req.json().catch(() => ({}));
    const token = String(b.token ?? "").trim();
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return json({ ok: false, error: "This link is not valid." }, 200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tok } = await service.from("tenancy_correction_tokens")
      .select("token, application_id, guarantee_ref, expires_at, submitted_at, applications(tenancy_start, prop_addr1, prop_postcode)")
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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(proposed)) return json({ ok: false, error: "Enter a valid date." }, 200);
      const note = String(b.note ?? "").trim().slice(0, 500) || null;
      // Record the report on the token row. This NEVER touches the application.
      // Clear any prior resolution so a fresh submission re-enters the review queue
      // (a re-submit after an earlier one was resolved is a new correction to review).
      await service.from("tenancy_correction_tokens").update({ proposed_start: proposed, note, submitted_at: new Date().toISOString(), resolved_at: null, resolved_by: null }).eq("token", token);
      // Needs-attention entry on the application's activity feed (opndoor-facing).
      await service.from("activity_log").insert({
        application_id: tok.application_id,
        kind: "tenancy_correction_reported",
        message: `${tok.guarantee_ref}: agent reports the tenancy start should be ${dmy(proposed)}${note ? ` (note: ${note})` : ""}. Review and amend if correct.`,
        actor: "Agent",
        visibility: "internal",
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
