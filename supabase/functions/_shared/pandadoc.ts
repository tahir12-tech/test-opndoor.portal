// =====================================================================
// PandaDoc (sandbox) helpers. API key, template id and webhook shared key are
// Edge Function secrets. Sandbox/test only: every recipient is routed to
// EMAIL_REVIEW_ADDRESS so no real tenant is emailed.
//
// The tenant is the only live signer. The opndoor signature is a facsimile
// image placed as static content in the template. The Issue Date is the deed's
// dated line and must NOT be recipient-editable, so it is a merge token
// (issue_date = the generation date, Europe/London) rather than a PandaDoc date
// field. Six tokens are merged from the application record; the template has one
// Signature field (Tenant) and no Date field.
// =====================================================================
const API = "https://api.pandadoc.com/public/v1";
// Trim: a stray space pasted into a secret (e.g. a leading space on the template
// id) otherwise yields PandaDoc 404 "Template is not available".
const KEY = (Deno.env.get("PANDADOC_API_KEY") ?? "").trim();
const TEMPLATE_ID = (Deno.env.get("PANDADOC_TEMPLATE_ID") ?? "").trim();
const WEBHOOK_KEY = (Deno.env.get("PANDADOC_WEBHOOK_SHARED_KEY") ?? "").trim();
const REVIEW = (Deno.env.get("EMAIL_REVIEW_ADDRESS") ?? "").trim();
// For the fallback signing-link email (when PandaDoc's own reminder is unavailable).
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "opndoor <payments@opndoor.co>";
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "hello@opndoor.co";

export function pandadocConfigured(): boolean {
  return Boolean(KEY && TEMPLATE_ID);
}

function headers(): Record<string, string> {
  return { Authorization: `API-Key ${KEY}`, "Content-Type": "application/json" };
}

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || "");
}

/** Today's date in Europe/London, as both dd/mm/yyyy (deed) and yyyy-mm-dd (DB). */
function londonToday(): { dmy: string; iso: string } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date());
  const d = parts.find((p) => p.type === "day")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const y = parts.find((p) => p.type === "year")!.value;
  return { dmy: `${d}/${m}/${y}`, iso: `${y}-${m}-${d}` };
}

export interface DeedApp {
  id: string;
  guarantee_ref: string;
  tenant_first_name: string;
  tenant_last_name: string;
  tenant_email: string;
  tenancy_start: string;
  prop_addr1: string;
  prop_addr2: string | null;
  prop_city: string;
  prop_postcode: string;
  agent_email: string;
  /** When true, this is a reissue after a tenancy-start amendment: the signing
      email says the deed was updated and the previous document is now void. */
  reissue?: boolean;
}

// The six merge tokens. The docx must define these token names (the naming is
// the contract that keeps the template swappable with no code change). issue_date
// is the deed's dated line (a merge token, never a recipient-editable field).
function tokens(a: DeedApp, issueDate: string) {
  const address = [a.prop_addr1, a.prop_addr2, a.prop_city, a.prop_postcode].filter(Boolean).join(", ");
  return [
    { name: "reference_number", value: a.guarantee_ref },
    { name: "tenant_name", value: `${a.tenant_first_name} ${a.tenant_last_name}` },
    { name: "tenancy_start_date", value: fmtDate(a.tenancy_start) },
    { name: "rental_address", value: address },
    { name: "agent_email", value: a.agent_email },
    { name: "issue_date", value: issueDate },
  ];
}

export interface DeedResult {
  ok: boolean;
  documentId?: string;
  /** The generation date printed on the deed, yyyy-mm-dd (set as the DB issue_date). */
  issueDateIso?: string;
  error?: string;
}

/** Create the deed document from the template and send it to the tenant to sign. */
export async function createAndSend(a: DeedApp): Promise<DeedResult> {
  if (!pandadocConfigured()) return { ok: false, error: "PandaDoc is not configured (PANDADOC_API_KEY / PANDADOC_TEMPLATE_ID)." };
  try {
    // The deed is dated at generation (Europe/London). This same date becomes the
    // DB issue_date, so the printed date and the record always agree.
    const issue = londonToday();
    const createRes = await fetch(`${API}/documents`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        name: `Deed of Guarantee - ${a.guarantee_ref}`,
        template_uuid: TEMPLATE_ID,
        // Sandbox: route the tenant recipient to the review address.
        recipients: [{ email: REVIEW || a.tenant_email, first_name: a.tenant_first_name, last_name: a.tenant_last_name, role: "Tenant" }],
        tokens: tokens(a, issue.dmy),
        metadata: { application_id: a.id, guarantee_ref: a.guarantee_ref },
      }),
    });
    if (!createRes.ok) return { ok: false, error: `PandaDoc create ${createRes.status}: ${(await createRes.text()).slice(0, 300)}` };
    const created = await createRes.json();
    const docId = created.id as string;

    // The document processes asynchronously to "document.draft" before it can be sent.
    for (let i = 0; i < 8; i++) {
      const st = await fetch(`${API}/documents/${docId}`, { headers: headers() });
      const doc = await st.json();
      if (doc.status === "document.draft") break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Explicit opndoor-branded notification copy (the sender display name itself
    // is account-level in PandaDoc, not settable per document; see the runbook).
    // A reissue (after a tenancy-start amendment) uses distinct copy so the tenant
    // knows the deed changed and the previous document is void.
    const subject = a.reissue
      ? `Your updated opndoor Deed of Guarantee, ${a.guarantee_ref}`
      : `Your opndoor Deed of Guarantee, ${a.guarantee_ref}`;
    // Closing line only on the initial send: a tenant may already have signed via
    // the payment confirmation page in the same generation window, so this email
    // can arrive after the fact. A reissue is admin-triggered later with no
    // confirmation-page path, so that race does not apply and the line is omitted.
    const alreadySigned = " Already signed? If you've completed your deed through the payment confirmation page, no further action is needed, you can disregard this email.";
    const message = a.reissue
      ? `Dear ${a.tenant_first_name} ${a.tenant_last_name}, your Deed of Guarantee has been updated to reflect a new tenancy start date of ${fmtDate(a.tenancy_start)}. The previous document is now void. Please review and sign this updated document to put your guarantee in place. Reference ${a.guarantee_ref}.`
      : `Dear ${a.tenant_first_name} ${a.tenant_last_name}, your opndoor guarantor fee has been received and your Deed of Guarantee is ready to sign. Please review and sign the document to put your guarantee in place. Reference ${a.guarantee_ref}.${alreadySigned}`;
    const sendRes = await fetch(`${API}/documents/${docId}/send`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ silent: false, subject, message }),
    });
    if (!sendRes.ok) return { ok: false, documentId: docId, error: `PandaDoc send ${sendRes.status}: ${(await sendRes.text()).slice(0, 300)}` };
    return { ok: true, documentId: docId, issueDateIso: issue.iso };
  } catch (e) {
    return { ok: false, error: `PandaDoc request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const TERMINAL_STATUSES = ["document.completed", "document.declined", "document.voided", "document.expired", "document.paid"];
function prettyStatus(s: string): string {
  return ({
    "document.completed": "already signed",
    "document.declined": "declined",
    "document.voided": "voided",
    "document.expired": "expired",
    "document.paid": "paid",
  } as Record<string, string>)[s] ?? s.replace("document.", "");
}

export interface RemindContext {
  guarantee_ref: string;
  tenant_first_name: string;
  tenant_last_name: string;
}
export interface RemindResult {
  ok: boolean;
  method?: "reminder" | "link";
  /** Partner-safe message shown to the user and in the business activity feed. */
  error?: string;
  /** Raw technical detail, logged opndoor-admin-only (never shown to partners). */
  technical?: string;
}

/**
 * Nudge the tenant to sign again, in whatever state the document is in. The
 * intent is always "make the tenant see it again":
 *  - terminal states (signed / declined / voided / expired): cannot remind, honest error;
 *  - sent or viewed: PandaDoc's manual reminder endpoint (works where /send 403s);
 *  - if the reminder endpoint is unavailable, re-deliver a fresh signing-session
 *    link to the tenant via our own email module.
 */
export async function remindSignature(documentId: string, ctx: RemindContext): Promise<RemindResult> {
  if (!pandadocConfigured()) return { ok: false, error: "PandaDoc is not configured." };
  // Read the current status and recipient (the state is what makes this safe).
  const docRes = await fetch(`${API}/documents/${documentId}`, { headers: headers() });
  if (!docRes.ok) return { ok: false, error: "Reminder could not be sent, please try again shortly.", technical: `Could not read the deed document (${docRes.status}).` };
  const doc = await docRes.json();
  const status: string = doc.status ?? "";
  if (TERMINAL_STATUSES.includes(status)) {
    return { ok: false, error: `The deed is ${prettyStatus(status)}, so a reminder cannot be sent. Use "Replace and resend deed" to issue a fresh one.` };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recips: any[] = Array.isArray(doc.recipients) ? doc.recipients : [];
  const rec = recips.find((r) => String(r.role ?? "").toLowerCase() === "tenant") ?? recips[0];
  const recipientId: string | null = rec?.recipient_id ?? rec?.id ?? null;
  const recipientEmail: string = rec?.email ?? REVIEW;

  // Preferred: PandaDoc's manual reminder (valid in SENT and VIEWED).
  if (recipientId) {
    const remRes = await fetch(`${API}/documents/${documentId}/send-reminder`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        reminders: [{
          recipient_id: recipientId,
          delivery_methods: { email: true },
          email_customization: {
            subject: `Reminder: your opndoor Deed of Guarantee, ${ctx.guarantee_ref}`,
            message: `Dear ${ctx.tenant_first_name} ${ctx.tenant_last_name}, this is a reminder that your opndoor Deed of Guarantee is ready to sign. Please review and sign the document to put your guarantee in place. Reference ${ctx.guarantee_ref}.`,
          },
        }],
      }),
    });
    if (remRes.ok) return { ok: true, method: "reminder" };
    // fall through to the link email if the plan/endpoint rejects it
  }

  // Fallback: mint a fresh signing-session link and email it ourselves.
  const link = await signingLink(documentId, recipientEmail);
  if (!link) return { ok: false, error: "Reminder could not be sent, please try again shortly.", technical: "Could not create a PandaDoc signing session for the tenant." };
  const em = await emailSigningLink(recipientEmail, link, ctx);
  // Email fallback unavailable (e.g. unverified Resend domain): honest copy for
  // partners; the raw provider error is returned for admin-only logging.
  if (!em.ok) return { ok: false, error: "Reminder could not be sent, email service awaiting configuration.", technical: em.error };
  return { ok: true, method: "link" };
}

/** A shareable signing-session link for a recipient (valid ~7 days). */
async function signingLink(documentId: string, recipientEmail: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/documents/${documentId}/session`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ recipient: recipientEmail, lifetime: 60 * 60 * 24 * 7 }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.id ? `https://app.pandadoc.com/s/${j.id}` : null;
  } catch {
    return null;
  }
}

/** Email the tenant the signing link (redirected to the review address in sandbox). */
async function emailSigningLink(tenantEmail: string, link: string, ctx: RemindContext): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_API_KEY) return { ok: false, error: "Resend is not configured, so the signing link could not be emailed." };
  const dest = REVIEW || tenantEmail;
  const subject = `Your opndoor Deed of Guarantee is ready to sign, ${ctx.guarantee_ref}`;
  const banner = REVIEW
    ? `<tr><td style="padding:10px 16px;background:#f8eff9;border-bottom:1px solid rgba(39,29,95,0.1);font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#5b4d86;">Test mode. This email was intended for ${tenantEmail} and redirected to you for review.</td></tr>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f3fa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3fa;padding:28px 0;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:92%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px -18px rgba(39,29,95,0.4);">
      <tr><td style="background:#271d5f;padding:22px 28px;"><span style="font:800 22px 'Sora',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:-0.04em;color:#fff;">opndoor</span><span style="font:600 12px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:rgba(255,255,255,0.7);margin-left:10px;">Guarantee Referral Portal</span></td></tr>
      ${banner}
      <tr><td style="padding:28px;font:400 15px/1.6 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#271d5f;">
        <p style="margin:0 0 14px;">Dear ${ctx.tenant_first_name} ${ctx.tenant_last_name},</p>
        <p style="margin:0 0 18px;">Your opndoor Deed of Guarantee is ready to sign. Please review and sign the document to put your guarantee in place. Reference ${ctx.guarantee_ref}.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;"><tr><td>
          <a href="${link}" style="display:inline-block;background:#d364fb;color:#fff;text-decoration:none;font:700 15px 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding:13px 28px;border-radius:999px;box-shadow:0 6px 18px -8px rgba(211,100,251,0.6);">Review and sign your deed</a>
        </td></tr></table>
        <p style="margin:14px 0 0;font-size:12px;color:#5b4d86;">If the button does not work, copy this link into your browser:<br><span style="color:#b54de0;word-break:break-all;">${link}</span></p>
      </td></tr>
      <tr><td style="padding:18px 28px;background:#f8eff9;font:400 12px/1.5 'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#5b4d86;">opndoor. Questions? Reply to this email or contact ${REPLY_TO}.</td></tr>
    </table>
  </td></tr></table></body></html>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [dest], reply_to: REPLY_TO, subject, html }),
    });
    if (!res.ok) return { ok: false, error: `Resend responded ${res.status}: ${(await res.text()).slice(0, 150)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Resend request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Void (retire) an outstanding document so the tenant can no longer sign it.
 * PandaDoc has no "voided" verb via API; the supported cancel path is setting
 * status Expired (11), allowed from Sent/Viewed. An already-terminal or missing
 * document is treated as effectively gone so regeneration can proceed.
 */
export async function voidDocument(documentId: string): Promise<{ ok: boolean; alreadyGone?: boolean; error?: string }> {
  if (!pandadocConfigured()) return { ok: false, error: "PandaDoc is not configured." };
  try {
    const res = await fetch(`${API}/documents/${documentId}/status`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status: 11, note: "Superseded by a regenerated deed.", notify_recipients: false }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.text()).slice(0, 200);
    // Already terminal / not found: nothing left to sign, so let regeneration continue.
    if ([400, 404, 409].includes(res.status)) return { ok: true, alreadyGone: true, error: `PandaDoc void ${res.status}: ${body}` };
    return { ok: false, error: `PandaDoc void ${res.status}: ${body}` };
  } catch (e) {
    return { ok: false, error: `PandaDoc void failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Download the executed PDF (available once the document is completed). */
export async function downloadPdf(documentId: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(`${API}/documents/${documentId}/download`, { headers: { Authorization: `API-Key ${KEY}` } });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** PandaDoc signs webhooks with HMAC-SHA256 of the raw body using the shared key. */
export async function verifyWebhook(rawBody: string, signature: string): Promise<boolean> {
  if (!WEBHOOK_KEY || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === signature.toLowerCase();
}

/**
 * Generate and send the deed for an application (agent email resolved server
 * side; generation is blocked with a clear error if there is no agent contact).
 * Used on the Paid transition and by the manual retry.
 */
// reissue = true when regenerating after a tenancy-start amendment: the signing
// email uses updated copy, and the routine "deed sent" business entry is
// suppressed so the amend caller can log a single combined amend entry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateDeed(service: any, appId: string, reissue = false): Promise<DeedResult> {
  const { data: app } = await service
    .from("applications")
    .select("id, guarantee_ref, tenant_first_name, tenant_last_name, tenant_email, tenancy_start, prop_addr1, prop_addr2, prop_city, prop_postcode, branch_id")
    .eq("id", appId)
    .maybeSingle();
  if (!app) return { ok: false, error: "Application not found." };

  const { data: contact } = await service.rpc("effective_primary_contact", { p_branch: app.branch_id });
  const c = Array.isArray(contact) ? contact[0] : contact;
  const agentEmail = c?.email ?? null;
  if (!agentEmail) {
    await service.from("applications").update({ deed_state: "error" }).eq("id", appId);
    await service.from("activity_log").insert({ application_id: appId, kind: "deed_error", message: "Deed not generated: add an agent contact for this branch, then retry.", actor: "System", visibility: "internal" });
    return { ok: false, error: "No agent contact for this branch. Add one, then retry." };
  }

  const res = await createAndSend({ ...app, agent_email: agentEmail, reissue });
  if (!res.ok) {
    await service.from("applications").update({ deed_state: "error" }).eq("id", appId);
    await service.from("activity_log").insert({ application_id: appId, kind: "deed_error", message: `Deed generation failed: ${res.error}`, actor: "System", visibility: "internal" });
    return res;
  }
  // issue_date is set here (at generation) to the date printed on the deed; the
  // completion webhook leaves it untouched. deed_issued_at stays the execution ts.
  // deed_viewed_at is reset so a freshly sent (or regenerated) deed starts as "not
  // yet viewed" for the new document.
  await service.from("applications").update({ pandadoc_document_id: res.documentId, deed_state: "awaiting_tenant", deed_sent_at: new Date().toISOString(), deed_viewed_at: null, issue_date: res.issueDateIso ?? null }).eq("id", appId);
  if (!reissue) {
    await service.from("activity_log").insert({ application_id: appId, kind: "deed_sent", message: "Deed of Guarantee sent to the tenant for signature.", actor: "System" });
  }
  return res;
}
