// =====================================================================
// invite-user (verify_jwt = true)
//
// Creates (or re-invites) a portal user and sends a BRANDED invite email via
// Resend, redirected to the review address in this test build. Same pattern as
// send-password-reset: the recovery/invite link is generated server-side (admin
// API, service role, so GoTrue's own mailer is NOT used) and delivered by our
// template. The link lands on /accept-invite, where the invitee sets a password
// and is handed into TOTP enrolment.
//
// Authorisation mirrors the Add-user UI: opndoor admins may invite any role
// (superadmins land under opndoor, everyone else under a named partner);
// management may invite referrers/managers into THEIR OWN partner only.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { inviteEmailTemplate, sendEmail } from "./email.ts";

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

    const b = await req.json().catch(() => ({}));
    const email = String(b.email ?? "").trim().toLowerCase();
    const role = String(b.role ?? "");
    const firstName = String(b.firstName ?? "").trim();
    const lastName = String(b.lastName ?? "").trim();
    const partnerSlug = String(b.partner ?? "").trim();
    const base = String(Deno.env.get("APP_URL") ?? b.origin ?? "").replace(/\/$/, "");

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: "A valid email address is required." }, 400);
    if (!["superadmin", "management", "referrer"].includes(role)) return json({ ok: false, error: "Invalid role." }, 400);

    // Caller-scoped client: identify + authorise the inviter.
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    const callerId = userData.user?.id;
    if (!callerId) return json({ ok: false, error: "Not authenticated." }, 401);
    const { data: caller } = await userClient.from("users").select("role, partner_id, full_name").eq("id", callerId).maybeSingle();
    if (!caller) return json({ ok: false, error: "Not permitted." }, 403);

    const service = createClient(SUPABASE_URL, SERVICE);

    // Resolve the invitee's partner + enforce who may invite whom.
    let inviteePartnerId: string | null = null;
    if (caller.role === "superadmin") {
      if (role !== "superadmin") {
        const { data: p } = await service.from("partners").select("id").eq("slug", partnerSlug).maybeSingle();
        if (!p?.id) return json({ ok: false, error: "Select a valid partner for this user." }, 400);
        inviteePartnerId = p.id;
      }
    } else if (caller.role === "management") {
      // Managers may only invite referrers/managers, and only into their own partner.
      if (!["referrer", "management"].includes(role)) return json({ ok: false, error: "Managers may only invite referrers or managers." }, 403);
      inviteePartnerId = caller.partner_id ?? null;
    } else {
      return json({ ok: false, error: "Not permitted." }, 403);
    }

    const fullName = `${firstName} ${lastName}`.trim() || email;

    // New vs re-invite: an existing portal user gets a recovery (set-password)
    // link; a new one is created by the invite link.
    const { data: existing } = await service.from("users").select("id, role, partner_id").ilike("email", email).maybeSingle();
    let link: string | undefined;
    let targetUserId: string | undefined = existing?.id;

    // Re-inviting must respect the SAME scope as inviting: management may only
    // re-invite referrers/managers in their own partner. Without this, the
    // service-role lookup would let management trigger a set-password link and an
    // audit row for any account (a superadmin's, or another partner's).
    if (existing && caller.role !== "superadmin") {
      const outOfScope = existing.partner_id !== inviteePartnerId || !["referrer", "management"].includes(existing.role);
      if (outOfScope) return json({ ok: false, error: "Not permitted." }, 403);
    }

    if (existing) {
      const { data, error } = await service.auth.admin.generateLink({
        type: "recovery", email, options: { redirectTo: `${base}/accept-invite` },
      });
      if (error) return json({ ok: false, error: error.message }, 400);
      link = data?.properties?.action_link;
    } else {
      const { data, error } = await service.auth.admin.generateLink({
        type: "invite", email, options: { redirectTo: `${base}/accept-invite`, data: { full_name: fullName } },
      });
      if (error) return json({ ok: false, error: error.message }, 400);
      link = data?.properties?.action_link;
      targetUserId = data?.user?.id;
      if (targetUserId) {
        const { error: insErr } = await service.from("users").insert({
          id: targetUserId, email, full_name: fullName, role, partner_id: inviteePartnerId, status: "pending",
        });
        if (insErr) return json({ ok: false, error: insErr.message }, 400);
      }
    }
    if (!link) return json({ ok: false, error: "Could not generate the invitation link." }, 400);

    // Branded invite email (redirected to the review address in test mode).
    const partnerName = inviteePartnerId
      ? (await service.from("partners").select("name").eq("id", inviteePartnerId).maybeSingle()).data?.name ?? ""
      : "";
    // #69: never expose a contact email as a display name. A name-less user's
    // full_name falls back to their email (see fullName above), so if such a user
    // is the inviter, drop it and let the template say "Your team".
    const inviterName = caller.full_name && !caller.full_name.includes("@") ? caller.full_name : "";
    const tpl = inviteEmailTemplate({ link, intendedFor: email, firstName, inviterName, partnerName });
    const emailRes = await sendEmail({ subject: tpl.subject, html: tpl.html });

    // Audit the invite (best-effort).
    if (targetUserId) {
      await service.from("user_audit").insert({
        target_user: targetUserId, partner_id: inviteePartnerId, action: "invited",
        old_value: null, new_value: role, actor: caller.full_name ?? "an administrator", actor_id: callerId,
      });
    }

    return json({ ok: true, emailSent: emailRes.ok, emailError: emailRes.ok ? null : emailRes.error });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
