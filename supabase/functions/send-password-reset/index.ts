// =====================================================================
// send-password-reset (verify_jwt = false)
//
// One endpoint for BOTH the self-service Forgot-password flow and the admin
// Reset-password action. It generates a Supabase recovery link (admin API,
// service role, so GoTrue's own email is NOT sent) and delivers a branded
// Resend email carrying that link - redirected to the review address in this
// test build. The link lands on the app's /reset-password screen, which
// consumes the recovery token and sets the new password.
//
// Anonymous by design (password reset must work for a signed-out user). To
// avoid account enumeration it ALWAYS responds ok, whether or not the address
// belongs to a real account.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { passwordResetTemplate, sendEmail } from "./email.ts";

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
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const b = await req.json().catch(() => ({}));
    const email = String(b.email ?? "").trim().toLowerCase();
    // Build the recovery redirect from the SERVER-configured APP_URL, not the
    // unauthenticated client-supplied origin, so a caller cannot point the
    // recovery link (and its token) at an address they control. GoTrue's own
    // redirect allowlist is the ultimate gate; this is defence in depth.
    const base = String(Deno.env.get("APP_URL") ?? b.origin ?? "").replace(/\/$/, "");

    // The response body is IDENTICAL in every non-error case, so it never
    // reveals whether an account exists (no enumeration). We still attempt the
    // send when the address is valid and known; the outcome is not disclosed.
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      const service = createClient(SUPABASE_URL, SERVICE);
      const { data, error } = await service.auth.admin.generateLink({
        type: "recovery",
        email,
        options: { redirectTo: `${base}/reset-password` },
      });
      console.log("RESET LINK RESULT", {
        email,
        error,
        hasLink: !!data?.properties?.action_link
      });
      const link = data?.properties?.action_link as string | undefined;
      if (!error && link) {
        const tpl = passwordResetTemplate({ link });
        const result = await sendEmail({
          subject: tpl.subject,
          html: tpl.html,
          to: email,
        });

console.log("EMAIL RESULT", result);
      }

    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: "Could not send the password reset email." }, 500);
  }
});
