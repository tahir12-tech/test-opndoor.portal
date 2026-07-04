// =====================================================================
// Tenant refund confirmation email, sent from the Stripe charge.refunded
// webhook. Branded shell shared with the rest of the portal's emails; ALWAYS
// redirected to EMAIL_REVIEW_ADDRESS in this test build (the real recipient
// appears only in the "intended for" banner). Idempotency is owned by the
// caller (the stripe_events dedup means charge.refunded runs once per event).
// =====================================================================
// deno-lint-ignore-file no-explicit-any
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "opndoor <payments@opndoor.co>";
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "hello@opndoor.co";
const REVIEW_ADDRESS = Deno.env.get("EMAIL_REVIEW_ADDRESS");

interface SendResult { ok: boolean; error?: string; to?: string }

async function sendEmail(opts: { subject: string; html: string }): Promise<SendResult> {
  if (!RESEND_API_KEY) return { ok: false, error: "Resend is not configured (RESEND_API_KEY not set)." };
  if (!REVIEW_ADDRESS) return { ok: false, error: "Test review address (EMAIL_REVIEW_ADDRESS) is not set." };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [REVIEW_ADDRESS], reply_to: REPLY_TO, subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { ok: false, error: `Resend responded ${res.status}: ${detail.slice(0, 200)}`, to: REVIEW_ADDRESS };
    }
    return { ok: true, to: REVIEW_ADDRESS };
  } catch (e) {
    return { ok: false, error: `Resend request failed: ${e instanceof Error ? e.message : String(e)}`, to: REVIEW_ADDRESS };
  }
}

const VALHALLA = "#271d5f";
const INK_SOFT = "#5b4d86";
const LILAC = "#f8eff9";

function layout(inner: string, intendedFor: string): string {
  const banner = `<tr><td style="padding:10px 16px;background:${LILAC};border-bottom:1px solid rgba(39,29,95,0.1);font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK_SOFT};">Test mode. This email was intended for ${intendedFor} and redirected to you for review.</td></tr>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f3fa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3fa;padding:28px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:92%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px -18px rgba(39,29,95,0.4);">
        <tr><td style="background:${VALHALLA};padding:22px 28px;">
          <span style="font:800 22px 'Sora',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:-0.04em;color:#ffffff;">opndoor</span>
          <span style="font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:rgba(255,255,255,0.7);margin-left:10px;">Guarantee Referral Portal</span>
        </td></tr>
        ${banner}
        <tr><td style="padding:28px;font:400 15px/1.6 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${VALHALLA};">${inner}</td></tr>
        <tr><td style="padding:18px 28px;background:${LILAC};font:400 12px/1.5 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK_SOFT};">opndoor. Questions? Reply to this email or contact ${REPLY_TO}.</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function refundEmailTemplate(p: { title: string; lastName: string; propertyAddr: string; amount: string; guaranteeRef: string; intendedFor: string }): { subject: string; html: string } {
  const dear = [p.title, p.lastName].filter((x) => (x || "").trim()).join(" ").trim();
  const subject = `Your guarantor fee has been refunded - ${p.guaranteeRef}`;
  const inner = `
    <p style="margin:0 0 14px;">Dear ${dear || "there"},</p>
    <p style="margin:0 0 16px;">Your guarantor fee for ${p.propertyAddr} has been refunded. The refund is on its way back to the card you paid with.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid rgba(39,29,95,0.12);border-radius:12px;"><tr><td style="padding:16px 18px;">
      <div style="font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:0.12em;text-transform:uppercase;color:${INK_SOFT};">Amount refunded</div>
      <div style="font:800 30px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${VALHALLA};margin-top:4px;">${p.amount}</div>
      <div style="font:400 13px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK_SOFT};margin-top:2px;">Reference ${p.guaranteeRef}.</div>
    </td></tr></table>
    <p style="margin:0 0 8px;font-size:13px;color:${INK_SOFT};">Refunds usually take 5 to 10 working days to appear, depending on your bank. You do not need to do anything.</p>
    <p style="margin:12px 0 0;font-size:13px;color:${INK_SOFT};">If you have any questions about this refund, reply to this email or contact ${REPLY_TO}.</p>`;
  return { subject, html: layout(inner, p.intendedFor) };
}

/** Send the branded refund confirmation and record the activity entries. */
export async function deliverRefund(service: any, p: { appId: string; tenantEmail: string; title: string; lastName: string; propertyAddr: string; amount: string; guaranteeRef: string }): Promise<void> {
  if (!p.tenantEmail) return;
  const tpl = refundEmailTemplate({ title: p.title, lastName: p.lastName, propertyAddr: p.propertyAddr, amount: p.amount, guaranteeRef: p.guaranteeRef, intendedFor: p.tenantEmail });
  const res = await sendEmail({ subject: tpl.subject, html: tpl.html });
  await service.from("activity_log").insert({
    application_id: p.appId,
    kind: res.ok ? "refund_email_sent" : "refund_email_failed",
    message: res.ok ? "Refund confirmation email sent to the tenant." : `Refund confirmation email not sent: ${res.error}`,
    actor: "System",
    visibility: res.ok ? "business" : "internal",
  });
  if (res.ok && res.to && res.to !== p.tenantEmail) {
    await service.from("activity_log").insert({
      application_id: p.appId, kind: "refund_email_sent",
      message: `Redirected to ${res.to} (test mode).`, actor: "System", visibility: "internal",
    });
  }
}
