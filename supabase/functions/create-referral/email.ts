// =====================================================================
// Reusable email module (Resend). One module, multiple templates:
// paymentEmailTemplate now; expiry-reminder templates slot in next using the
// same layout() shell and sendEmail().
//
// TEST SAFETY: in this build every message is redirected to EMAIL_REVIEW_ADDRESS
// so real tenant addresses from seed/demo data are never emailed. The template
// shows who the message was intended for.
// =====================================================================
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "opndoor <payments@opndoor.co>";
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "hello@opndoor.co";
const REVIEW_ADDRESS = Deno.env.get("EMAIL_REVIEW_ADDRESS");

export interface SendResult {
  ok: boolean;
  error?: string;
  to?: string;
}

/** Send a message. Always redirects to the review address in this test build. */
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

// Both email for review and tenat
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

//email for only tenat
export async function sendEmail(opts: { subject: string; html: string; to: string }): Promise<SendResult> {
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
const HELIOTROPE = "#d364fb";
const HELIOTROPE_DEEP = "#b54de0";
const INK_SOFT = "#5b4d86";
const LILAC = "#f8eff9";

//layout for both review & email

// function layout(title: string, inner: string, intendedFor?: string): string {
//   const testBanner = intendedFor
//     ? `<tr><td style="padding:10px 16px;background:${LILAC};border-bottom:1px solid rgba(39,29,95,0.1);font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK_SOFT};">Test mode. This email was intended for ${intendedFor} and redirected to you for review.</td></tr>`
//     : "";
//   return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f3fa;">
//   <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3fa;padding:28px 0;">
//     <tr><td align="center">
//       <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:92%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px -18px rgba(39,29,95,0.4);">
//         <tr><td style="background:${VALHALLA};padding:22px 28px;">
//           <span style="font:800 22px 'Sora',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:-0.04em;color:#ffffff;">opndoor</span>
//           <span style="font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:rgba(255,255,255,0.7);margin-left:10px;">Guarantee Referral Portal</span>
//         </td></tr>
//         ${testBanner}
//         <tr><td style="padding:28px;font:400 15px/1.6 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${VALHALLA};">
//           ${inner}
//         </td></tr>
//         <tr><td style="padding:18px 28px;background:${LILAC};font:400 12px/1.5 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK_SOFT};">
//           opndoor. Questions? Reply to this email or contact ${REPLY_TO}.
//         </td></tr>
//       </table>
//     </td></tr>
//   </table></body></html>`;
// }


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

export function paymentEmailTemplate(p: {
  title: string;
  lastName: string;
  propertyAddr: string;
  guaranteeRef: string;
  amount: string;
  payUrl: string;
 
}): { subject: string; html: string } {
  const subject = `Complete your guarantor fee payment - ${p.guaranteeRef}`;
  const inner = `
    <p style="margin:0 0 14px;">Dear ${p.title} ${p.lastName},</p>
    <p style="margin:0 0 14px;">You've been referred to opndoor's professional guarantor service to support your tenancy at ${p.propertyAddr}. To put your Deed of Guarantee in place, please pay the one-off guarantor fee below.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border:1px solid rgba(39,29,95,0.12);border-radius:12px;">
      <tr><td style="padding:16px 18px;">
        <div style="font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:0.12em;text-transform:uppercase;color:${INK_SOFT};">Guarantor fee</div>
        <div style="font:800 30px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${VALHALLA};margin-top:4px;">${p.amount}</div>
        <div style="font:400 13px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK_SOFT};margin-top:2px;">One month's rent. Reference ${p.guaranteeRef}.</div>
      </td></tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;"><tr><td>
      <a href="${p.payUrl}" style="display:inline-block;background:${HELIOTROPE};color:#ffffff;text-decoration:none;font:700 15px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding:13px 28px;border-radius:999px;box-shadow:0 6px 18px -8px rgba(211,100,251,0.6);">Pay the guarantor fee</a>
    </td></tr></table>
    <p style="margin:0 0 8px;font-size:13px;color:${INK_SOFT};">It's a one-off payment for opndoor to act as your professional guarantor, providing a Deed of Guarantee in favour of the property so your tenancy can proceed. Payment is secure and handled by Stripe.</p>
    <p style="margin:14px 0 0;font-size:12px;color:${INK_SOFT};">No longer need this? <a href="${p.payUrl}" style="color:${HELIOTROPE_DEEP};">Let us know</a> and we'll close it off. No payment will be taken.</p>
    <p style="margin:14px 0 0;font-size:12px;color:${INK_SOFT};">If the button does not work, copy this link into your browser:<br><span style="color:${HELIOTROPE_DEEP};word-break:break-all;">${p.payUrl}</span></p>`;
  return { subject, html: layout(subject) };
}
