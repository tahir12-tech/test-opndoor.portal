// =====================================================================
// #4 Tenant executed-deed email, sent from the PandaDoc document.completed
// webhook alongside the agent delivery. Congratulatory register with a download
// link to the tenant's own signed Deed of Guarantee. Branded shell shared with
// the portal's other emails; ALWAYS redirected to EMAIL_REVIEW_ADDRESS in this
// test build. Idempotency is owned by the caller (pandadoc_events dedup keyed on
// docId:status means document.completed runs once).
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
const HELIOTROPE = "#d364fb";
const HELIOTROPE_DEEP = "#b54de0";
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

function ddmmyyyy(iso: string | null): string {
  if (!iso) return "your tenancy start date";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function template(p: { tenantName: string; propertyAddr: string; tenancyStartLabel: string; guaranteeRef: string; downloadUrl: string; intendedFor: string }): { subject: string; html: string } {
  const subject = `Your Deed of Guarantee is signed and issued - ${p.guaranteeRef}`;
  const button = p.downloadUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 8px;"><tr><td>
        <a href="${p.downloadUrl}" style="display:inline-block;background:${HELIOTROPE};color:#ffffff;text-decoration:none;font:700 15px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding:13px 28px;border-radius:999px;box-shadow:0 6px 18px -8px rgba(211,100,251,0.6);">Download your Deed of Guarantee</a>
      </td></tr></table>`
    : `<p style="margin:0 0 8px;font-size:13px;color:${INK_SOFT};">Your signed deed is on file with opndoor. Contact us quoting the reference to receive a copy.</p>`;
  const inner = `
    <p style="margin:0 0 14px;">Dear ${p.tenantName || "there"},</p>
    <p style="margin:0 0 16px;">Great news, your Deed of Guarantee for ${p.propertyAddr} is signed and issued. opndoor is now your professional guarantor for this tenancy, in force from ${p.tenancyStartLabel} and covering 12 months from then. Your letting agent has received the executed deed, so your tenancy can proceed.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid rgba(39,29,95,0.12);border-radius:12px;background:${LILAC};"><tr><td style="padding:14px 18px;">
      <div style="font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:0.12em;text-transform:uppercase;color:${INK_SOFT};">Guarantee reference</div>
      <div style="font:800 20px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${VALHALLA};margin-top:2px;">${p.guaranteeRef}</div>
    </td></tr></table>
    ${button}
    <p style="margin:12px 0 0;font-size:13px;color:${INK_SOFT};">Please keep this with your tenancy documents. The download link expires in a few days; if you ever need the deed re-sent, contact us quoting the reference.</p>`;
  return { subject, html: layout(inner, p.intendedFor) };
}

/** Email the tenant their signed deed (with a short-lived download link) and log it. */
export async function deliverExecutedDeedToTenant(service: any, p: { appId: string; ref: string; tenantEmail: string; tenantName: string; propertyAddr: string; tenancyStart: string | null; pdfPath: string | null }): Promise<void> {
  if (!p.tenantEmail) return;
  let downloadUrl = "";
  if (p.pdfPath) {
    const { data: signed } = await service.storage.from("deeds").createSignedUrl(p.pdfPath, 604800); // 7 days
    downloadUrl = signed?.signedUrl ?? "";
  }
  const tpl = template({
    tenantName: p.tenantName,
    propertyAddr: p.propertyAddr,
    tenancyStartLabel: ddmmyyyy(p.tenancyStart),
    guaranteeRef: p.ref,
    downloadUrl,
    intendedFor: p.tenantEmail,
  });
  const res = await sendEmail({ subject: tpl.subject, html: tpl.html });
  await service.from("activity_log").insert({
    application_id: p.appId,
    kind: res.ok ? "tenant_deed_email_sent" : "tenant_deed_email_failed",
    message: res.ok ? "Signed deed emailed to the tenant." : `Tenant deed email not sent: ${res.error}`,
    actor: "System",
    visibility: res.ok ? "business" : "internal",
  });
  if (res.ok && res.to && res.to !== p.tenantEmail) {
    await service.from("activity_log").insert({
      application_id: p.appId, kind: "tenant_deed_email_sent",
      message: `Redirected to ${res.to} (test mode).`, actor: "System", visibility: "internal",
    });
  }
}
