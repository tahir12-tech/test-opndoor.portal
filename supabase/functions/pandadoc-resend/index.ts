// =====================================================================
// pandadoc-resend (verify_jwt = true)
//
// Manual "Resend signature request" for owning Referrer / Management / admin
// (enforced by RLS on the caller-scoped read). If the deed is awaiting the
// tenant, it re-sends the existing document; if it errored, was declined or
// voided, it generates a fresh document. Logged to the activity feed.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
/* remindSignature is no longer imported. It asks PandaDoc to nudge a
   recipient PandaDoc has never emailed, which since `silent: true` is
   nobody. Left in pandadoc.ts rather than deleted: it is still the correct
   call if the silent send is ever reversed, and removing it would make that
   reversal look bigger than it is. */
import { generateDeed } from "../_shared/pandadoc.ts";
import { deliverSigningInvite } from "../_shared/signingInvite.ts";

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
      .select("id, status, deed_state, pandadoc_document_id, guarantee_ref, tenant_first_name, tenant_last_name, tenant_email, livemode, tenancy_start")
      .eq("guarantee_ref", ref)
      .maybeSingle();
    if (error) {
      return json({ ok: false, error: "Could not find the application." }, 400);
    }
    if (!app) return json({ ok: false, error: "Application not found, or you do not have access to it." }, 404);
    if (app.status !== "paid" || app.payment_state === "refunded") return json({ ok: false, error: "The deed can only be (re)sent while the application is Paid and awaiting execution." }, 400);

    const service = createClient(SUPABASE_URL, SERVICE);
    if (app.deed_state === "awaiting_tenant" && app.pandadoc_document_id) {
      /* DID A CORRECTION REPLACE THIS DEED? Matt, 2026-10-03: "If the deed
         was reissued after a start-date correction, say so."

         READ FROM THE ACTIVITY LOG, which is where the fact already is:
         both correction paths write `tenancy_correction_applied`. The
         delivery columns cannot answer it -- `deed_delivery_superseded_at`
         is only set when there was a delivery to supersede, and a deed
         corrected while still unsigned never had one, which is exactly
         the case Matt is looking at. */
      const { data: corrections } = await service
        .from("activity_log")
        .select("id")
        .eq("application_id", app.id)
        .eq("kind", "tenancy_correction_applied")
        .limit(1);
      const replacesEarlierDeed = (corrections?.length ?? 0) > 0;

      /* OPNDOOR'S EMAIL, NOT PANDADOC'S REMINDER. Matt (ai): "'Resend
         signature request' on the application must send Opndoor's email
         with a fresh signing link."

         THIS PATH HAD TO MOVE OR IT WOULD SEND NOTHING AT ALL. The document
         is now created with `silent: true`, so PandaDoc issues no email of
         its own; `remindSignature` asked PandaDoc to nudge a recipient it
         had never written to. The button would have reported success and
         the tenant would have heard nothing -- which is worse than the two
         emails this change exists to fix, because nobody would know.

         THE LINK IS THE PAY PAGE and it is the same door as the payment
         email. "Fresh" is the signing SESSION, minted when the tenant
         arrives, not a new URL: a PandaDoc session minted here would be
         stale by the time they opened the email.

         `replacesEarlierDeed` STILL DECIDES THE WORDS. A deed reissued
         after a start-date correction reads as a duplicate otherwise, and
         a tenant who files it as one leaves two deeds disagreeing about a
         date. It used to be passed to PandaDoc's message; it is now passed
         to ours. */
      const result = await deliverSigningInvite(service, app.id, {
        reissue: replacesEarlierDeed,
        by: actor,
      });
      if (!result.ok) {
        // Honest, partner-safe entry for everyone; the raw detail stays
        // internal (opndoor-admin-only). No raw error reaches the partner.
        await service.from("activity_log").insert([
          { application_id: app.id, kind: "deed_reminder_failed", message: "The signing email could not be sent. opndoor has been notified.", actor: "System", visibility: "business" },
          { application_id: app.id, kind: "deed_reminder_failed", message: `Resend failed: ${result.error ?? "no detail"}`, actor: "System", visibility: "internal" },
        ]);
        return json({ ok: false, error: "The signing email could not be sent. opndoor has been notified." }, 200);
      }
      /* NOT SENT IS NOT FAILED, and the message has to tell them apart. The
         invite declines to chase a deed that is already executed or
         cancelled, which is a correct outcome and not an error -- reporting
         "re-sent" there would have somebody waiting for an email that was
         deliberately not sent. */
      if (!result.sent) {
        return json({ ok: true, message: "Nothing to re-send: this deed is already signed or has been cancelled." });
      }
      const message = replacesEarlierDeed
        ? "Corrected deed sent to the tenant to sign."
        : "Signing link re-sent to the tenant.";
      await service.from("activity_log").insert({ application_id: app.id, kind: "deed_reminded", message: `${message} (by ${actor})`, actor });
      return json({ ok: true, message });
    }
    // No live document (errored / declined / voided): generate a fresh one.
    const gen = await generateDeed(service, app.id);
    if (!gen.ok) return json({ ok: false, error: gen.error }, 200);
    /* AND THE EMAIL, because PandaDoc no longer sends one. Without this the
       reply below would be a lie: a fresh deed would exist and the tenant
       would never hear about it. */
    const invite = await deliverSigningInvite(service, app.id, { by: actor });
    if (!invite.ok) {
      return json({ ok: false, error: "A fresh deed was issued, but the email to the tenant could not be sent. opndoor has been notified." }, 200);
    }
    return json({ ok: true, message: "Fresh deed sent to the tenant to sign." });
  } catch (e) {
    return json({ ok: false, error: "Could not resend the deed." }, 500);
  }
});
