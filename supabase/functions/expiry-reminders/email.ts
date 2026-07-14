// =====================================================================
// Branded email module for expiry reminders (Resend). Same layout() shell and
// sendEmail() pattern as the payment email module.
//
// TEST SAFETY: every message is redirected to EMAIL_REVIEW_ADDRESS so real
// referrer/management addresses are never emailed while the domain is
// unverified. The template shows who it was intended for. sendEmail returns a
// structured result so the caller can log failures honestly (no raw 403s reach
// partners - they still get the in-app activity reminder).
// =====================================================================
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "opndoor <payments@opndoor.co>";
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "hello@opndoor.co";


export interface SendResult { ok: boolean; error?: string; to?: string; }

/** Send a message. Always redirects to the review address in this test build. */
// export async function sendEmail(opts: { subject: string; html: string }): Promise<SendResult> {
//   if (!RESEND_API_KEY) return { ok: false, error: "Resend is not configured (RESEND_API_KEY not set)." };
//   if (!REVIEW_ADDRESS) return { ok: false, error: "Test review address (EMAIL_REVIEW_ADDRESS) is not set." };
//   try {
//     const res = await fetch("https://api.resend.com/emails", {
//       method: "POST",
//       headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
//       body: JSON.stringify({ from: EMAIL_FROM, to: [REVIEW_ADDRESS], reply_to: REPLY_TO, subject: opts.subject, html: opts.html }),
//     });
//     if (!res.ok) return { ok: false, error: `Resend responded ${res.status}: ${(await res.text()).slice(0, 200)}`, to: REVIEW_ADDRESS };
//     return { ok: true, to: REVIEW_ADDRESS };
//   } catch (e) {
//     return { ok: false, error: `Resend request failed: ${e instanceof Error ? e.message : String(e)}`, to: REVIEW_ADDRESS };
//   }
// }

//email for both review and user
// export async function sendEmail(opts: { subject: string; html: string; to?: string }): Promise<SendResult> {
//   if (!RESEND_API_KEY) return { ok: false, error: "Resend is not configured (RESEND_API_KEY not set)." };
//   if (!REVIEW_ADDRESS) return { ok: false, error: "Test review address (EMAIL_REVIEW_ADDRESS) is not set." };
//   const recipients = [REVIEW_ADDRESS];
//   if (opts.to && opts.to !== REVIEW_ADDRESS) recipients.push(opts.to);
//   try {
//     const res = await fetch("https://api.resend.com/emails", {
//       method: "POST",
//       headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
//       body: JSON.stringify({ from: EMAIL_FROM, to: recipients, reply_to: REPLY_TO, subject: opts.subject, html: opts.html }),
//     });
//     if (!res.ok) {
//       const detail = await res.text();
//       return { ok: false, error: `Resend responded ${res.status}: ${detail.slice(0, 200)}`, to: recipients.join(", ") };
//     }
//     return { ok: true, to: recipients.join(", ") };
//   } catch (e) {
//     return { ok: false, error: `Resend request failed: ${e instanceof Error ? e.message : String(e)}`, to: recipients.join(", ") };
//   }
// }

//email for only user
export async function sendEmail(opts: { subject: string; html: string; to?: string }): Promise<SendResult> {
  if (!RESEND_API_KEY) return { ok: false, error: "Resend is not configured (RESEND_API_KEY not set)." };
  if (!opts.to) return { ok: false, error: "No recipient email provided." };
  const recipients = [opts.to];
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: recipients, reply_to: REPLY_TO, subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { ok: false, error: `Resend responded ${res.status}: ${detail.slice(0, 200)}`, to: recipients.join(", ") };
    }
    return { ok: true, to: recipients.join(", ") };
  } catch (e) {
    return { ok: false, error: `Resend request failed: ${e instanceof Error ? e.message : String(e)}`, to: recipients.join(", ") };
  }
}


const VALHALLA = "#271d5f";
const INK_SOFT = "#5b4d86";
const LILAC = "#f8eff9";

//email for tenat only 
function layout(inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f3fa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3fa;padding:28px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:92%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px -18px rgba(39,29,95,0.4);">
        <tr><td style="background:${VALHALLA};padding:22px 28px;">
          <span style="font:800 22px 'Sora',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:-0.04em;color:#ffffff;">opndoor</span>
          <span style="font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:rgba(255,255,255,0.7);margin-left:10px;">Guarantee Referral Portal</span>
        </td></tr>
        <tr><td style="padding:28px;font:400 15px/1.6 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${VALHALLA};">${inner}</td></tr>
        <tr><td style="padding:18px 28px;background:${LILAC};font:400 12px/1.5 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK_SOFT};">opndoor. Questions? Reply to this email or contact ${REPLY_TO}.</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

export interface ExpiryReminderInput {
  guaranteeRef: string;
  prop: string;
  agency: string;
  branch: string;
  daysUntil: number;
  expiryDmy: string;
  intendedFor: string;
}

/** "expires today" / "expires tomorrow" / "expires in N days". */
function expiresPhrase(days: number): string {
  if (days <= 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

export function expiryReminderTemplate(p: ExpiryReminderInput): { subject: string; html: string } {
  const phrase = expiresPhrase(p.daysUntil);
  const subject = `Guarantee ${phrase} - ${p.guaranteeRef}`;
  const where = [p.branch, p.agency].filter(Boolean).join(" · ");
  const inner = `
    <p style="margin:0 0 14px;">A guarantee you referred is approaching expiry.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;border:1px solid rgba(39,29,95,0.12);border-radius:12px;">
      <tr><td style="padding:16px 18px;">
        <div style="font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:0.12em;text-transform:uppercase;color:${INK_SOFT};">Deed of Guarantee ${p.guaranteeRef}</div>
        <div style="font:800 22px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${VALHALLA};margin-top:6px;text-transform:capitalize;">${phrase}</div>
        <div style="font:400 13px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK_SOFT};margin-top:6px;">Expiry date ${p.expiryDmy}${p.prop ? ` · ${p.prop}` : ""}${where ? ` · ${where}` : ""}</div>
      </td></tr>
    </table>
    <p style="margin:0 0 8px;font-size:13px;color:${INK_SOFT};">If the tenancy is continuing, arrange a renewal or send a fresh referral so cover stays in place. The guarantee period is 12 months from the tenancy start date.</p>`;
  return { subject, html: layout(inner) };
}
