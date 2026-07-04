// =====================================================================
// Deed-to-agent delivery, shared by the automatic path (pandadoc-webhook, on
// execution) and the manual path (send-deed-to-agent). Sends the branded deed
// email to the resolved claim contact with a short-lived signed download link,
// and writes the activity log. In this test build every message is redirected to
// EMAIL_REVIEW_ADDRESS; the business activity entry names the intended recipient
// and the test-mode redirect is a separate opndoor-admin-only internal entry.
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

function detailRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:6px 0;font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK_SOFT};white-space:nowrap;vertical-align:top;">${label}</td>
    <td style="padding:6px 0 6px 16px;font:600 14px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${VALHALLA};">${value}</td>
  </tr>`;
}

// Owner-approved final copy. Greets the agency team by name (never a contact's
// email address, #69); the recipient is a letting-agent branch with no portal
// access, so the tone is comfort + completeness with no portal pitch.
function deedAgentTemplate(p: {
  agencyName: string; tenantTitle: string; tenantName: string; addr1: string; postcode: string;
  tenancyStartLabel: string; guaranteeRef: string; downloadUrl: string; intendedFor: string;
}): { subject: string; html: string } {
  const teamName = (p.agencyName || "").trim();
  const greet = teamName ? `Dear team at ${teamName},` : "Dear team,";
  const propertyLine = [p.addr1, p.postcode].filter(Boolean).join(", ");
  const tenantLine = [p.tenantTitle, p.tenantName].filter((x) => (x || "").trim()).join(" ").trim();
  const subject = `Deed of Guarantee issued, ${p.guaranteeRef}, ${p.addr1}`;
  const button = p.downloadUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 8px;"><tr><td>
        <a href="${p.downloadUrl}" style="display:inline-block;background:${HELIOTROPE};color:#ffffff;text-decoration:none;font:700 15px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding:13px 28px;border-radius:999px;box-shadow:0 6px 18px -8px rgba(211,100,251,0.6);">Download the Deed of Guarantee</a>
      </td></tr></table>`
    : `<p style="margin:0 0 8px;font-size:13px;color:${INK_SOFT};">The signed deed is on file with opndoor. Contact us quoting the reference to receive a copy.</p>`;
  const inner = `
    <p style="margin:0 0 14px;">${greet}</p>
    <p style="margin:0 0 16px;">The Deed of Guarantee for <b>${tenantLine}</b> at ${propertyLine} has been signed and issued. opndoor is now the professional guarantor for this tenancy, and nothing further is needed from you, the guarantee is in place.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid rgba(39,29,95,0.12);border-radius:12px;background:${LILAC};"><tr><td style="padding:14px 18px;">
      <div style="font:700 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:0.12em;text-transform:uppercase;color:${INK_SOFT};margin-bottom:6px;">Guarantee details</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${detailRow("Tenant", tenantLine)}
        ${detailRow("Property", propertyLine)}
        ${detailRow("Tenancy start", p.tenancyStartLabel)}
        ${detailRow("Guarantee period", "12 months from tenancy start")}
        ${detailRow("Reference", p.guaranteeRef)}
      </table>
    </td></tr></table>
    ${button}
    <p style="margin:12px 0 0;font-size:13px;color:${INK_SOFT};">Please keep the deed with the tenancy paperwork, it's the reference for any claim under the guarantee. The download link expires in a few days; if you ever need the deed re-sent, contact us quoting the reference.</p>`;
  return { subject, html: layout(inner, p.intendedFor) };
}

export interface DeedTarget {
  appId: string;
  ref: string;
  tenantTitle: string;
  tenantName: string;
  addr1: string;
  postcode: string;
  /** ISO tenancy start date (yyyy-mm-dd); rendered dd/mm/yyyy in the email. */
  tenancyStart: string | null;
  agencyName: string;
  pdfPath: string | null;
}
export interface DeedRecipient { email: string; name: string }

/** dd/mm/yyyy from an ISO date, or an em-dash-free placeholder. */
function ddmmyyyy(iso: string | null): string {
  if (!iso) return "the tenancy start date";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/**
 * Deliver the issued deed to the resolved claim contact: mint a signed download
 * link, email it (redirected to the review address in test mode), and write the
 * partner-safe "Deed sent to <email> · <mode>" activity entry plus an admin-only
 * internal entry for the test-mode redirect. Returns the send outcome.
 */
export async function deliverDeedToAgent(service: any, target: DeedTarget, recipient: DeedRecipient, mode: string): Promise<SendResult> {
  let downloadUrl = "";
  if (target.pdfPath) {
    const { data: signed } = await service.storage.from("deeds").createSignedUrl(target.pdfPath, 604800); // 7 days
    downloadUrl = signed?.signedUrl ?? "";
  }
  const tpl = deedAgentTemplate({
    agencyName: target.agencyName,
    tenantTitle: target.tenantTitle,
    tenantName: target.tenantName,
    addr1: target.addr1,
    postcode: target.postcode,
    tenancyStartLabel: ddmmyyyy(target.tenancyStart),
    guaranteeRef: target.ref,
    downloadUrl,
    intendedFor: recipient.email,
  });
  const res = await sendEmail({ subject: tpl.subject, html: tpl.html });

  // Partner-safe business entry names the intended agent contact; the test-mode
  // redirect target stays admin-only (a separate internal entry).
  await service.from("activity_log").insert({
    application_id: target.appId,
    kind: res.ok ? "deed_delivered" : "deed_delivery_failed",
    message: res.ok ? `Deed sent to ${recipient.email} · ${mode}` : `Deed email to the agent could not be sent: ${res.error}`,
    actor: "System",
    visibility: res.ok ? "business" : "internal",
  });
  if (res.ok && res.to && res.to !== recipient.email) {
    await service.from("activity_log").insert({
      application_id: target.appId,
      kind: "deed_delivered",
      message: `Redirected to ${res.to} (test mode).`,
      actor: "System",
      visibility: "internal",
    });
  }
  return { ...res, to: recipient.email };
}
