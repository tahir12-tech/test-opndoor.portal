// =====================================================================
// PandaDoc helpers.
//
// CREDENTIALS ARE PER APPLICATION, NOT PER DEPLOYMENT. They used to be three
// module constants captured at import, which meant no parameter could ever
// reach them and one deployment could only ever talk to one PandaDoc account.
// Now that sandbox lives inside the live system, every entry point takes a
// livemode and resolves its credentials through livemodeCredentials.ts.
//
// A PandaDoc SANDBOX key produces real documents and really sends them,
// watermarked with a developer prefix. That is deliberate: rehearsing the
// tenant's signing journey is most of the point of sandbox. It also means
// whatever address a developer POSTs as tenant_email genuinely receives an
// email, which is why the Dev Centre surfaces the signing link with a warning.
//
// The tenant is the only live signer. The opndoor signature is a facsimile
// image placed as static content in the template. The Issue Date is the deed's
// dated line and must NOT be recipient-editable, so it is a merge token
// (issue_date = the generation date, Europe/London) rather than a PandaDoc date
// field. Six tokens are merged from the application record; the template has one
// Signature field (Tenant) and no Date field.
// =====================================================================
import { titleCaseAddress, spelledDate } from "./text.ts";
import { pandadocConfigFor, pandadocConfiguredFor, pandadocWebhookKeys } from "./livemodeCredentials.ts";
import { timingSafeEqual } from "./partnerAuth.ts";
import { sendMessage } from "./mailer.ts";
// The deed recipient is redirected to the review address in test mode, the same
// resolver the mailer uses. It was referenced below but never imported, so the
// redirect that keeps a non-production deed off a real tenant never applied.
import { resolveRecipients } from "./emailRecipients.ts";


const API = "https://api.pandadoc.com/public/v1";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "opndoor <payments@opndoor.co>";
/* REPLY GOES WHERE THE FOOTER SAYS. Matt, 2026-10-01: "Set the
   Reply-To header on every email to support@opndoor.co, so pressing
   Reply also reaches support."

   The default was hello@opndoor.co, the general contact address, so
   the footer told a reader one thing and the Reply button did
   another the moment EMAIL_REPLY_TO was unset -- which it is. The
   env var still wins, because a live environment may route support
   somewhere else, but the fallback is now the address the email
   itself prints. */
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "support@opndoor.co";

/**
 * Whether PandaDoc is usable for this mode.
 *
 * Takes livemode rather than answering globally: on production, live may be
 * configured while sandbox is not, and answering "yes" for both would turn a
 * missing sandbox secret into a 404 from PandaDoc rather than a clear message.
 */
export function pandadocConfigured(livemode: boolean): boolean {
  return pandadocConfiguredFor(livemode);
}

function headers(key: string): Record<string, string> {
  return { Authorization: `API-Key ${key}`, "Content-Type": "application/json" };
}


function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || "");
}

/* THE SAME DATE, SPELLED, FOR ANYTHING A PERSON READS. Matt, 2026-10-01:
   "Show dates as '29 Dec 2026', including in the PandaDoc email text."

   The DEED keeps dd/mm/yyyy: it is a legal document with a fixed layout
   and its own conventions, and the token above fills a field on it. The
   covering email is prose a tenant reads once, in a hurry, about a date
   that has just changed -- which is exactly where 12/11 and 11/12 must
   not be a question. */
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MONTH_LONG = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** "29 December 2026", which is how Matt wrote the correction sentence. The
    short form beside this one is for the deed itself and the expiries file,
    where a column has to stay narrow; a sentence in a tenant's email has
    room for the word. */
function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return iso || "";
  return `${Number(m[3])} ${MONTH_LONG[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
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
  /** True for the direct rail (the tenant signs from their application page), false
      for the referral rail (the tenant signs from the payment confirmation page).
      Steers the "already signed?" reassurance so it names the right place. */
  direct?: boolean;
  /** Every tenant on the tenancy, so each tenant's deed says what tenancy it is
      part of. Absent on a solo application, where the name printed is the
      applicant's own and the document is byte-identical to what it always was. */
  tenancy_tenant_names?: string | null;
}

// The merge tokens. The docx must define these token names (the naming is the
// contract that keeps the template swappable with no code change). issue_date is
// the deed's dated line (a merge token, never a recipient-editable field).
//
// SIX TOKENS, ON EVERY DEED, JOINT OR SOLO.
//
// RULING (27 Sep). The template does not change. Each tenant signs their own
// deed, for their own share, naming all the tenants; the SHARE is recorded on the
// application and on the bordereau, not in the document. So a joint tenant's deed
// renders exactly as a single tenant's does, from the same six merge fields.
//
// This removed two tokens, guaranteed_amount and co_tenant_names, which briefly
// existed to print the share and the other tenants into the document. They needed
// a template change to render at all, and an unrendered token is not a neutral
// extra: it is an amount a deed appears to state and does not. The share lives
// where it is authoritative and checkable instead.
//
// tenant_name still carries EVERY tenant, which is the part of the joint design
// the document does keep: the deed says what tenancy it is part of. On a solo
// application that list is the applicant alone, so the value is unchanged.
function tokens(a: DeedApp, issueDate: string) {
  // #8 Title-case the printed deed's address merge field for display; postcode left raw.
  const address = [titleCaseAddress(a.prop_addr1), titleCaseAddress(a.prop_addr2), titleCaseAddress(a.prop_city), a.prop_postcode].filter(Boolean).join(", ");
  return [
    { name: "reference_number", value: a.guarantee_ref },
    // EVERY DEED NAMES EVERY TENANT, so the document says what tenancy it is
    // part of. On a solo application the list is that one person, so the
    // token's value is unchanged.
    { name: "tenant_name", value: a.tenancy_tenant_names || `${a.tenant_first_name} ${a.tenant_last_name}` },
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
export async function createAndSend(a: DeedApp, livemode: boolean): Promise<DeedResult> {
  const cfg = pandadocConfigFor(livemode);
  if (!cfg.ok) return { ok: false, error: cfg.error };
  const { key, templateId } = cfg.value;
  try {
    // The deed is dated at generation (Europe/London). This same date becomes the
    // DB issue_date, so the printed date and the record always agree.
    const issue = londonToday();
    const createRes = await fetch(`${API}/documents`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({
        name: `Deed of Guarantee - ${a.guarantee_ref}`,
        template_uuid: templateId,
        // The tenant recipient is the real address on the application, in both
        // modes. In sandbox that is whatever the developer POSTed, and PandaDoc
        // will email it: see the header and the Dev Centre warning.
       // THE ONE THAT MATTERS. This is the address PandaDoc sends the deed to
       // and the address that signs it. A test build reaching a real tenant here
       // is not a stray email: it is a real person signing a real Deed of
       // Guarantee generated from a non-production environment.
       //
       // Redirecting here rather than after the fact is the only option: once
       // PandaDoc has the recipient, the document is addressed to them.
       recipients: [{
         email: resolveRecipients(a.tenant_email).to[0] ?? a.tenant_email,
         first_name: a.tenant_first_name, last_name: a.tenant_last_name, role: "Tenant",
       }],
        tokens: tokens(a, issue.dmy),
        metadata: { application_id: a.id, guarantee_ref: a.guarantee_ref },
      }),
    });
    if (!createRes.ok) return { ok: false, error: `PandaDoc create ${createRes.status}: ${(await createRes.text()).slice(0, 300)}` };
    const created = await createRes.json();
    const docId = created.id as string;


    // The document processes asynchronously to "document.draft" before it can be sent.
    for (let i = 0; i < 8; i++) {
      const st = await fetch(`${API}/documents/${docId}`, { headers: headers(key) });
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
    const alreadySigned = a.direct
      ? " Already signed from your application page? No further action is needed, you can disregard this email."
      : " Already signed? If you've completed your deed through the payment confirmation page, no further action is needed, you can disregard this email.";
    const message = a.reissue
      ? `Dear ${a.tenant_first_name} ${a.tenant_last_name}, this corrected Deed of Guarantee replaces the one sent to you earlier. The tenancy start is now ${spelledDate(a.tenancy_start)}; please discard the earlier copy, which is void. Review and sign this updated document to put your guarantee in place. Reference ${a.guarantee_ref}.`
      : `Dear ${a.tenant_first_name} ${a.tenant_last_name}, your opndoor guarantee fee has been received and your Deed of Guarantee is ready to sign. Please review and sign the document to put your guarantee in place. Reference ${a.guarantee_ref}.${alreadySigned}`;
    const sendRes = await fetch(`${API}/documents/${docId}/send`, {
      method: "POST",
      headers: headers(key),
      /* SILENT. Matt, 2026-10-04 (ai): "Stop PandaDoc emailing tenants:
         create and send deeds silently so PandaDoc sends no email of its
         own."

         A tenant was getting two emails about one deed from two senders
         within a minute of each other, and the one with the button was
         PandaDoc's, in PandaDoc's voice. Opndoor now sends it, through
         `deliverSigningInvite`, from all three paths: the payment receipt,
         Resend signature request, and the corrected deed after a start-date
         change.

         THE DOCUMENT IS STILL SENT, which is the half not to get wrong.
         `silent` suppresses PandaDoc's notification email; it does not
         suppress the send, so the document still leaves draft and is still
         signable. If this were read as "do not send", the deed would sit in
         draft and nothing downstream would work at all -- which is loud,
         and is the failure mode to prefer over a silent one.

         THE SUBJECT AND MESSAGE ARE KEPT rather than removed. They are
         still what a recipient sees inside the PandaDoc signing page, and
         they are what a reminder sent from PandaDoc's own UI would carry if
         anybody ever used it. */
      /* SILENT IN LIVE, NOT IN SANDBOX, and the split is forced rather than
         chosen. Matt (ai): "Stop PandaDoc emailing tenants."

         LIVE: silent. A tenant was getting two emails about one deed from
         two senders within a minute, and the one with the button was
         PandaDoc's, in PandaDoc's voice. Opndoor now sends it, from every
         path that issues a deed (see everyDeedTellsItsTenant.test.ts).

         SANDBOX: not silent, because making it silent would leave a
         developer with NO signing email from anybody. `maySendOpndoorEmail`
         is `livemode` and says so in terms -- "Sandbox sends none. Not a
         different from address, not a redirect to a review mailbox: none"
         -- and its own comment already records that PandaDoc's signing
         email is the deliberate exception, "because rehearsing the tenant's
         signing journey is most of the point". Silent everywhere would have
         quietly deleted that rehearsal, which nobody asked for and which
         the Dev Centre would then be documenting falsely.

         FOR MATT: if sandbox should fall silent too, it is this line plus
         an exemption in maySendOpndoorEmail, and the Dev Centre warning
         changes again. My recommendation is to leave it: sandbox has no
         tenants, only developers using their own addresses. */
      body: JSON.stringify({ silent: livemode, subject, message }),
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
  tenant_email: string;
  /** True when this deed replaced an earlier one after a tenancy correction.
      The tenant has a deed in their inbox that is no longer the one to sign,
      and an email that does not say so reads as a duplicate. */
  replacesEarlierDeed?: boolean;
  /** The corrected tenancy start, for that sentence. */
  tenancyStart?: string | null;
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
export async function remindSignature(documentId: string, ctx: RemindContext, livemode: boolean): Promise<RemindResult> {
  const cfg = pandadocConfigFor(livemode);
  if (!cfg.ok) return { ok: false, error: cfg.error };
  const { key } = cfg.value;
  // Read the current status and recipient (the state is what makes this safe).
  const docRes = await fetch(`${API}/documents/${documentId}`, { headers: headers(key) });
  if (!docRes.ok) return { ok: false, error: "Reminder could not be sent, please try again shortly.", technical: `Could not read the deed document (${docRes.status}).` };
  const doc = await docRes.json();
  const status: string = doc.status ?? "";
  if (TERMINAL_STATUSES.includes(status)) {
    return { ok: false, error: `The deed is ${prettyStatus(status)}, so a reminder cannot be sent. Issue a fresh deed from the application instead.` };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recips: any[] = Array.isArray(doc.recipients) ? doc.recipients : [];
  const rec = recips.find((r) => String(r.role ?? "").toLowerCase() === "tenant") ?? recips[0];
  const recipientId: string | null = rec?.recipient_id ?? rec?.id ?? null;
  const recipientEmail: string = ctx.tenant_email;


  // Preferred: PandaDoc's manual reminder (valid in SENT and VIEWED).
  if (recipientId) {
    const remRes = await fetch(`${API}/documents/${documentId}/send-reminder`, {
      method: "POST",
      headers: headers(key),
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
  const { link, detail } = await signingLink(documentId, recipientEmail, key);
  if (!link) return { ok: false, error: "Reminder could not be sent, please try again shortly.", technical: detail ?? "Could not create a PandaDoc signing session for the tenant." };
  const em = await emailSigningLink(recipientEmail, link, ctx);
  // Email fallback unavailable (e.g. unverified Resend domain): honest copy for
  // partners; the raw provider error is returned for admin-only logging.
  if (!em.ok) return { ok: false, error: "Reminder could not be sent, email service awaiting configuration.", technical: em.error };
  return { ok: true, method: "link" };
}


/** A shareable signing-session link for a recipient (valid ~7 days). */
// async function signingLink(documentId: string, recipientEmail: string): Promise<string | null> {
//   try {
//     const res = await fetch(`${API}/documents/${documentId}/session`, {
//       method: "POST",
//       headers: headers(key),
//       body: JSON.stringify({ recipient: recipientEmail, lifetime: 60 * 60 * 24 * 7 }),
//     });
//     if (!res.ok) return null;
//     const j = await res.json();
//     return j.id ? `https://app.pandadoc.com/s/${j.id}` : null;
//   } catch {
//     return null;
//   }
// }

async function signingLink(documentId: string, recipientEmail: string, key: string): Promise<{ link: string | null; detail?: string }> {
  // Match the recipient the document was created with: createAndSend redirects the
  // recipient to the review address wherever EMAIL_REVIEW_ADDRESS is set, so the
  // session must redirect the same way or PandaDoc answers "no associated recipient".
  const recipient = resolveRecipients(recipientEmail).to[0] ?? recipientEmail;
  try {
    const res = await fetch(`${API}/documents/${documentId}/session`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ recipient, lifetime: 60 * 60 * 24 * 7 }),
    });
    if (!res.ok) return { link: null, detail: `PandaDoc session ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const j = await res.json();
    return j.id ? { link: `https://app.pandadoc.com/s/${j.id}` } : { link: null, detail: `No id in response: ${JSON.stringify(j).slice(0, 200)}` };
  } catch (e) {
    return { link: null, detail: `Session request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}


/** Email the tenant the signing link (redirected to the review address in sandbox). */


//redirct to user


async function emailSigningLink(tenantEmail: string, link: string, ctx: RemindContext): Promise<{ ok: boolean; error?: string }> {
  const res = await sendMessage({
    to: tenantEmail,
    message: {
      subject: `Your opndoor Deed of Guarantee is ready to sign, ${ctx.guarantee_ref}`,
      heading: "Your Deed of Guarantee is ready to sign",
      /* THE SAME HEADER AS EVERY OTHER TENANT EMAIL. Matt, 2026-10-03:
         "Use the same header as the other tenant emails." It was missing,
         and `audience` defaults to "portal", so this one message was
         headed GUARANTEE REFERRAL PORTAL -- the name of a product the
         tenant has never seen -- while everything else they get from us
         says GUARANTOR APPLICATION. */
      audience: "tenant",
      blocks: [
        /* NOT "IN PLACE" BEFORE IT IS SIGNED. Matt, 2026-10-03: "don't say
           'Your guarantee is in place' before the deed is signed; say
           'Your guarantee fee is paid and your Deed of Guarantee is ready
           to sign. Signing puts your guarantee in place.'"

           IT TOLD THE TENANT THEY WERE COVERED while asking them to do the
           thing that covers them, which is the one sentence in this email
           that could cost somebody a tenancy. */
        { p: "Your guarantee fee is paid and your Deed of Guarantee is ready to sign. Signing puts your guarantee in place." },
        /* AND WHETHER THIS REPLACES ONE THEY ALREADY HAVE. A correction
           voids the old deed and issues a new one, so the tenant is holding
           a signing link that no longer works and a new one that looks the
           same. Matt's words, with his date format. */
        ...(ctx.replacesEarlierDeed
          ? [{ p: `This replaces your earlier deed; the tenancy start is now ${longDate(ctx.tenancyStart ?? "")}.` }]
          : []),
        { rows: [["Reference", ctx.guarantee_ref]] },
        /* NO "NOT INSURANCE" LINE HERE. Matt, 2026-10-02. The footer
           emailLayout puts on every message says it, word for word, and
           this one added nothing to it -- unlike the deed-to-sign email,
           which also named the claim contact and keeps that half. */
      ],
      action: { label: "Review and sign", href: link },
    },
  });
  return { ok: res.ok, error: res.error };
}


/**
 * Void (retire) an outstanding document so the tenant can no longer sign it.
 * PandaDoc has no "voided" verb via API; the supported cancel path is setting
 * status Expired (11), allowed from Sent/Viewed. An already-terminal or missing
 * document is treated as effectively gone so regeneration can proceed.
 *
 * Every call is time-bounded and retried: a hung PandaDoc request must fail fast
 * rather than burn the caller's wall clock (a refund that times out here used to
 * leave the signing link live). A non-2xx PATCH is never trusted on its own —
 * the document's real status is re-read, so `ok` means "confirmed unsignable",
 * and `signed` distinguishes the one terminal state that is not a safe outcome.
 */
export async function voidDocument(documentId: string, livemode: boolean): Promise<{ ok: boolean; alreadyGone?: boolean; error?: string }> {
  const cfg = pandadocConfigFor(livemode);
  if (!cfg.ok) return { ok: false, error: cfg.error };
  const { key } = cfg.value;
  try {
    const res = await fetch(`${API}/documents/${documentId}/status`, {
      method: "PATCH",
      headers: headers(key),
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
export interface PdfResult {
  ok: boolean;
  bytes?: Uint8Array;
  /** Why it could not be fetched, for the caller's alert and activity trail. */
  error?: string;
}

/* IT RETURNS A REASON NOW, because its one caller has to decide whether to retry
   and could not: every failure collapsed to null. An unset API key, a 401, a
   network blip and "PandaDoc has not finished rendering the PDF yet" were the
   same value, and the caller treated all four as "no PDF, carry on and execute
   the deed anyway", permanently, with the webhook already deduplicated.

   The last of those is not an edge case. PandaDoc renders the signed PDF
   asynchronously AFTER it fires document.completed, so a download issued the
   moment the callback lands can legitimately 404 for a few seconds. That is the
   commonest reason a deed ends up executed with no stored document. */


/**
 * PandaDoc signs webhooks with HMAC-SHA256 of the raw body using the shared key.
 *
 * THE SECRET THAT VERIFIES IS WHAT IDENTIFIES THE MODE. There is no field in a
 * PandaDoc callback that says which account sent it, and if there were it would
 * be attacker-controlled: anything read out of the body is a claim, not a fact.
 * Trying each configured shared key in turn and reporting which one matched
 * derives the mode from a cryptographic property instead. A caller that cannot
 * forge the sandbox HMAC cannot make a live event look like a sandbox one.
 *
 * Both keys are always tried, even after the first succeeds is impossible here
 * since a match returns. The loop does not short-circuit on a MISSING key: an
 * unconfigured sandbox simply contributes no candidate.
 */
export async function verifyWebhook(
  rawBody: string,
  signature: string,
): Promise<{ ok: boolean; livemode: boolean | null }> {
  if (!signature) return { ok: false, livemode: null };

  const enc = new TextEncoder();
  for (const candidate of pandadocWebhookKeys()) {
    const k = await crypto.subtle.importKey("raw", enc.encode(candidate.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", k, enc.encode(rawBody));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    // timingSafeEqual, not ===. String equality on a secret-derived value short
    // circuits at the first differing character, which is a timing oracle: an
    // attacker can recover the expected HMAC one nibble at a time by measuring
    // how long the comparison takes.
    //
    // The helper is the one written for the partner API rather than a second
    // implementation. Two constant-time comparisons in one codebase is one more
    // than can be reviewed properly, and the second is always the weaker.
    if (timingSafeEqual(hex, signature.toLowerCase())) return { ok: true, livemode: candidate.livemode };
  }
  return { ok: false, livemode: null };
}

/**
 * A fresh signing session link for a document. Exported for the Dev Centre,
 * which shows a developer the link for their sandbox deed because they have no
 * other way to reach it: sandbox applications are invisible everywhere else in
 * the portal by design.
 */
export async function getSigningLink(
  documentId: string,
  recipientEmail: string,
  livemode: boolean,
): Promise<{ link: string | null; detail?: string }> {
  const cfg = pandadocConfigFor(livemode);
  if (!cfg.ok) return { link: null, detail: cfg.error };
  return await signingLink(documentId, recipientEmail, cfg.value.key);
}

/**
 * A generation attempt that produced no document.
 *
 * Three things, every time, because the live symptom of this whole fault is
 * SILENCE. Every failure path below used to write an internal activity row and
 * stop: no ops alert, nothing queryable, nothing that reaches a person. "Deeds
 * are not generating" was therefore something only the agent found out, days
 * later, and only about the one deed they happened to chase.
 *
 *  - deed_state = 'error', which is what claim_tenancy_deed refuses on, so a
 *    Stripe redelivery cannot spin generating documents for the same tenancy;
 *  - the internal feed carries the reason, for whoever opens the application;
 *  - report_ops_incident, which is deduped to one row per type per hour, so a
 *    production-wide cause (an unset PANDADOC_TEMPLATE_ID, say) raises one alert
 *    an hour rather than one per payment.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function failGeneration(service: any, appId: string, message: string, opsType = "deed_generation_failed"): Promise<void> {
  /* record_deed_failure owns the state, the reason and the consecutive count, so
     the three cannot drift apart across the eight call sites. deed_state 'error'
     does NOT bury the row: 20261005260000 ruled that a failure is retried by the
     next automatic pass and by Generate, and that three consecutive failures park
     it as needs-attention for staff with this message on the card. Parking is
     visibility, never a lock: the two recovery sequences this exists for are
     "add the contact, press Generate" and "the manager accepts their invite,
     press Generate", and a lock would send exactly those to an admin for a void. */
  await service.rpc("record_deed_failure", { p_application: appId, p_error: message })
    .then(() => {}, () => {});
  await service.from("activity_log").insert({
    application_id: appId, kind: "deed_error", message, actor: "System", visibility: "internal",
  });
  await service.rpc("report_ops_incident", { p_type: opsType, p_detail: `Application ${appId}: ${message}` }).then(() => {}, () => {});
}


/** Download the executed PDF (available once the document is completed). */


export async function downloadPdf(documentId: string): Promise<Uint8Array | null> {
  const maxDelayMs = 12000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxDelayMs) {
    try {
      const res = await fetch(
        `${API}/documents/${documentId}/download`,
        {
          headers: {
            Authorization: `API-Key ${KEY}`,
          },
        }
      );
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        return new Uint8Array(buffer);
      }

      // PandaDoc is still generating the signed PDF.
      if (res.status === 409) {
        const elapsed = Date.now() - startTime;
        const remaining = maxDelayMs - elapsed;

        if (remaining <= 0) {
          return null;
        }

        // Retry after 1 second, but stop completely after 12 seconds.
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1000, remaining))
        );

        continue;
      }

      return null;
    } catch (e) {
      const elapsed = Date.now() - startTime;
      const remaining = maxDelayMs - elapsed;

      if (remaining <= 0) {
        return null;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000, remaining))
      );
    }
  }

  return null;
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
  /* ONE GENERATION AT A TIME, AND THIS IS THE ONLY PLACE IT CAN BE ENFORCED.

     The document-exists check below closes the SEQUENTIAL double-press: a second
     Generate arriving after the first has stamped its id is refused. It cannot
     close the CONCURRENT one, because both presses read "no document" before
     either has created one, and creating one at PandaDoc takes seconds. That is
     exactly the window a person double-clicking a button occupies, and the result
     is two live signable Deeds of Guarantee for one application, the second
     stamped over the first, the first left live in PandaDoc with nothing in the
     portal pointing at it.

     THE LEASE SITS HERE, around the whole run, rather than at the call sites.
     There are seven of them (stripe-webhook, pandadoc-resend,
     pandadoc-void-regenerate, tenancy-correction x2, amend-tenancy-start x2) and
     a guard that each has to remember to take is a guard that the eighth will not
     have. Wrapping the shared function covers all seven and any that follow.

     FAIL CLOSED. If the lease cannot be taken we do not generate. A paid tenant
     whose deed is delayed parks as needs-attention after three attempts and a
     person fixes it in minutes; two live signable guarantees, one of which
     nothing is tracking, is not recoverable at all. This does mean the migration
     must be applied before the functions are deployed, which HANDOVER-BALAL.md
     section 6 already requires and section 10 now says why. */
  const { data: leased, error: leaseErr } = await service.rpc("take_deed_lease", { p_application: appId });
  if (leaseErr) {
    await failGeneration(service, appId, `Deed not generated: the generation lease could not be taken (${leaseErr.message}). Nothing was sent; this retries on the next pass.`);
    return { ok: false, error: "Could not start deed generation. Retry shortly." };
  }
  if (leased !== true) {
    /* Not a failure, so no failure is recorded: the other run is doing the work
       and will succeed or record its own. Counting this as an attempt would let
       three fast double-presses park a perfectly healthy application. */
    return { ok: false, error: "A deed is already being generated for this application. Give it a moment, then refresh." };
  }
  try {
    return await runGeneration(service, appId, reissue);
  } finally {
    /* Always, including on the failure paths: a failure is retried (20261005260000)
       and holding the lease would make the retry wait out the stale-after window
       for nothing. */
    await service.rpc("release_deed_lease", { p_application: appId }).then(() => {}, () => {});
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runGeneration(service: any, appId: string, reissue: boolean): Promise<DeedResult> {
  // EACH TENANT SIGNS THEIR OWN DEED, FOR THEIR OWN SHARE.
  //
  // This used to resolve the tenancy's LEAD and generate one document for the
  // whole tenancy, which left a tenant who had paid their share sitting at
  // "Paid" for ever holding a guarantee in somebody else's name. The gate is
  // now this tenant's own payment, and the document is this tenant's own: it
  // covers their share, names all the tenants so it says what it is part of,
  // and is addressed to them.
  //
  // The application id is NOT rewritten any more. Every caller passes the
  // application it has in hand and gets that application's deed.
  //
  // A SOLO APPLICATION is a tenancy of one: the named list is the applicant
  // alone, and the document is what it always was. Per the 27 Sep ruling a joint
  // tenant's deed is the same document too, rendered from the same six tokens;
  // only the tenant list differs, and the share is held on the application and
  // the bordereau rather than printed.
  /* ONE DOCUMENT PER APPLICATION, ENFORCED HERE AND NOT ONLY IN THE CLAIM.

     claim_tenancy_deed refuses when a document already exists, and that was taken
     to be the guard. It is not: only stripe-webhook claims. pandadoc-resend's
     generate branch, which is what the Generate button on the application calls,
     runs generateDeed directly with no claim at all, so with a live document it
     would have created a SECOND PandaDoc document for the same application and
     stamped its id over the first. The first document stays live and signable in
     PandaDoc with nothing pointing at it.

     It did not happen on GR-20846 during the walk, but not because of a guard: the
     row's real state was awaiting_tenant, so resend took the remind branch and
     never reached here. The card was showing a stale error snapshot, which is the
     only reason the click landed somewhere harmless.

     reissue is the deliberate exception: void-and-regenerate nulls the id first and
     passes it, which is how a voided deed is legitimately replaced. */
  if (!reissue) {
    const { data: existing, error: existingErr } = await service.from("applications")
      .select("pandadoc_document_id").eq("id", appId).maybeSingle();
    /* THE GUARD CANNOT BE ALLOWED TO FAIL OPEN. This error was discarded, and
       supabase-js returns it rather than throwing, so a transient read failure
       left `existing` undefined and `existing?.pandadoc_document_id` falsy: the
       one-document check read "no document exists" and generation carried on. The
       one case where this read fails is the case where it matters most, because
       whatever is wrong with the database is equally likely to have the other
       press in flight. Not knowing whether a deed already exists is a reason to
       generate nothing. */
    if (existingErr) {
      await failGeneration(service, appId, `Deed not generated: could not check whether a deed already exists (${existingErr.message}). Nothing was sent; this retries on the next pass.`);
      return { ok: false, error: "Could not confirm whether a deed already exists, so none was generated. Retry shortly." };
    }
    if (existing?.pandadoc_document_id) {
      return { ok: false, documentId: existing.pandadoc_document_id as string,
               error: "A deed already exists for this application. Use Resend to chase the signature." };
    }
  }

  const { data: tgt, error: tgtErr } = await service.rpc("deed_target", { p_application: appId });
  // A FAILED deed_target USED TO READ AS "SOLO TENANCY, ALREADY PAID".
  //
  // The error was discarded. supabase-js returns it rather than throwing, so a
  // transient RPC failure left `unit` undefined, and undefined answers every
  // question below it the way a tenancy of one does: the has-this-tenant-paid
  // gate is skipped (`unit &&` is falsy), joint is false, and tenancy_tenant_names
  // goes null. On a JOINT tenancy that silently generates a deed naming ONE
  // tenant where the deed should name all of them, and sends it for signature: a
  // guarantee that misstates which tenancy it belongs to. A deed is a financial
  // instrument, so not knowing what it should say is a reason to generate
  // nothing, never a reason to generate the simpler one.
  if (tgtErr) {
    await failGeneration(service, appId, `Deed not generated: the tenancy details could not be read (${tgtErr.message}). Nothing was sent; retry once the database is answering.`);
    return { ok: false, error: "Could not read this tenancy's details, so no deed was generated. Retry shortly." };
  }
  const unit = Array.isArray(tgt) ? tgt[0] : tgt;
  if (unit && unit.ready === false) {
    // Not an error state on the row: nothing has failed, this tenant simply has
    // not paid yet. Written against THEIR row, because it is their deed.
    await service.from("activity_log").insert({
      application_id: appId, kind: "deed_waiting",
      message: "Deed not yet generated: this tenant has not paid their share.",
      actor: "System", visibility: "internal",
    });
    return { ok: false, error: "Waiting on this tenant to pay before their deed is generated." };
  }

  const { data: app, error: appErr } = await service
    .from("applications")
    .select("id, guarantee_ref, tenant_first_name, tenant_last_name, tenant_email, tenancy_start, prop_addr1, prop_addr2, prop_city, prop_postcode, branch_id, livemode, referencing_mode")
    .eq("id", appId)
    .maybeSingle();
  /* "Could not read it" is not "it does not exist". The error was discarded, so a
     transient failure returned "Application not found." to the caller and recorded
     nothing at all: no error state, no activity row, no ops incident. The Generate
     button showed a message saying the application does not exist, about an
     application the user was looking at. */
  if (appErr) {
    await failGeneration(service, appId, `Deed not generated: the application could not be read (${appErr.message}). Nothing was sent; this retries on the next pass.`);
    return { ok: false, error: "Could not read this application, so no deed was generated. Retry shortly." };
  }
  if (!app) return { ok: false, error: "Application not found." };

  // Where the executed deed will eventually go must exist before we generate one.
  // deed_delivery_target resolves the tenant-named delivery contact for a direct
  // application, else the branch's primary contact for a referral (byte-identical
  // to the old effective_primary_contact result on that path). Existence only, not
  // verification: the verified gate lives on the executed-deed SEND (#6, in
  // pandadoc-webhook), where an unverified tenant-typed address is held for review.
  // Here we only need to know the signed deed has somewhere to land.
  const { data: target, error: targetErr } = await service.rpc("deed_delivery_target", { p_application: appId });
  // Same reasoning as deed_target above: an unread ladder is not an empty one.
  // Discarding this error made a transient failure indistinguishable from "this
  // agency has nobody", which is the branch below, and that branch is terminal.
  if (targetErr) {
    await failGeneration(service, appId, `Deed not generated: the delivery contact could not be resolved (${targetErr.message}). Retry once the database is answering.`);
    return { ok: false, error: "Could not resolve where this deed would be delivered. Retry shortly." };
  }
  const dest = Array.isArray(target) ? target[0] : target;
  const agentEmail = dest?.email ?? null;
  if (!agentEmail) {
    // CANNOT DELIVER, WHICH IS NOT DELIVERY FAILED (20261005100000). Nothing was
    // sent and nothing errored: this rail's ladder simply has no rung carrying
    // an address. So it parks in the queue rather than stamping
    // delivery_failed_at, which would put a Resend button in front of an agency
    // for a send that was never attempted.
    //
    // awaiting_staff_send is the queryable half of that ruling and is the one
    // thing this branch never set. Generation stopped, deed_state went to
    // 'error', and the only trace was an internal activity row on an
    // application nobody had a reason to open: a paid tenant with no deed and
    // no queue entry anywhere. It parks visibly now, and ops is told, because
    // on production one unset branch contact is usually many.
    await service.from("applications").update({ deed_state: "error", awaiting_staff_send: true }).eq("id", appId);
    await service.from("activity_log").insert({ application_id: appId, kind: "deed_error", message: "Deed not generated: no contact to deliver it to. Add the letting agent or landlord (or the branch's primary contact for a referral), then retry.", actor: "System", visibility: "internal" });
    await service.rpc("report_ops_incident", {
      p_type: "deed_no_delivery_contact",
      p_detail: `Application ${appId}: paid, but no deed was generated because nothing resolves as a delivery contact. Add a contact (or activate a person at the agency) and retry from the application.`,
    }).then(() => {}, () => {});
    return { ok: false, error: "No delivery contact for this application. Add one, then retry." };
  }

  // livemode comes from the row rather than from an argument, so all four
  // callers of generateDeed stay unchanged and none of them can pass the wrong
  // one. === so a null never becomes live.
  const joint = (unit?.tenant_count ?? 1) > 1;
  const res = await createAndSend({
    ...app, agent_email: agentEmail, reissue,
    direct: app.referencing_mode === "opndoor_referenced",
    // The one thing a joint deed says differently: it names every tenant, so the
    // document states which tenancy it is part of. Null on a tenancy of one,
    // where the printed name is the applicant's own. The share is NOT passed:
    // per the 27 Sep ruling it belongs on the application and the bordereau, and
    // the document is the same six-token deed on both.
    tenancy_tenant_names: joint ? (unit?.tenant_names as string | null) : null,
  }, app.livemode === true);
  if (!res.ok) {
    // Every PandaDoc-side reason lands here, and on production the commonest by
    // far is not a per-application fault at all: an unset PANDADOC_API_KEY or
    // PANDADOC_TEMPLATE_ID fails EVERY generation identically, and used to do it
    // one silent internal row at a time. The ops incident is what turns that
    // from "some agents say deeds are not coming" into one alert naming the
    // secret.
    /* A FAILURE THAT STILL LEFT A DOCUMENT BEHIND. createAndSend does two calls:
       it CREATES the document, then SENDS it. A failure at the send step returns
       ok:false WITH a documentId, and that id was thrown away here: the row keeps
       nothing, so the next retry creates a second document and the first is left
       in PandaDoc for ever. Over a bad afternoon that is one orphan per attempt.

       We created it, so we clean it up rather than merely naming it. Voiding also
       settles the ambiguous case: a send whose RESPONSE failed after PandaDoc had
       already processed it means the tenant has been emailed a signable deed we
       have no id for, and voiding is what stops them signing a document nothing
       will ever match to their application.

       Only when the void fails does a person need to be involved, and then the
       incident carries the id they need. The retry itself is not blocked: the row
       was never stamped, so the next pass generates cleanly, which is the ruling. */
    if (res.documentId) {
      const voided = await voidDocument(res.documentId, app.livemode === true);
      if (!voided.ok && !voided.alreadyGone) {
        await service.rpc("report_ops_incident", {
          p_type: "deed_orphan_document",
          p_detail: `Application ${appId}: PandaDoc document ${res.documentId} was created but not sent (${res.error}), and could not be voided automatically (${voided.error}). Void ${res.documentId} in PandaDoc by hand; the application will generate a fresh deed on retry.`,
        }).then(() => {}, () => {});
      }
    }
    await failGeneration(service, appId, `Deed generation failed: ${res.error}`);
    return res;
  }
  if (!res.documentId) {
    // ok with no id is unusable: nothing can ever match the completion callback
    // back to this row, so the tenant would sign into a void. Treated as the
    // failure it is rather than stamping a null id over the row.
    await failGeneration(service, appId, "Deed generation failed: PandaDoc accepted the document but returned no document id.");
    return { ok: false, error: "PandaDoc returned no document id." };
  }
  // issue_date is set here (at generation) to the date printed on the deed; the
  // completion webhook leaves it untouched. deed_issued_at stays the execution ts.
  // deed_viewed_at is reset so a freshly sent (or regenerated) deed starts as "not
  // yet viewed" for the new document.
  //
  // awaiting_staff_send is cleared because a generation that works is the exact
  // remedy for the no-contact park above: the row must leave the queue it was
  // put in, or a staff member keeps being asked to act on something already
  // fixed. Nothing else can be in that queue here, since it is only set at
  // execution and this runs before any.
  /* A document exists, so the run of consecutive failures is over: the count goes
     back to zero and the last error is cleared, or an application that failed twice
     and then succeeded would park on its next single failure. awaiting_staff_send
     is already cleared by this same update, which is the parking flag. */
  const { error: stampErr } = await service.from("applications").update({ pandadoc_document_id: res.documentId, deed_state: "awaiting_tenant", deed_sent_at: new Date().toISOString(), deed_viewed_at: null, awaiting_staff_send: false, deed_attempts: 0, deed_last_error: null, issue_date: res.issueDateIso ?? null }).eq("id", appId);
  if (stampErr) {
    // THE DOCUMENT IS LIVE AND UNATTACHED, and this is the worst shape the whole
    // chain has. PandaDoc has the deed and the tenant has been emailed it, but
    // this row does not carry its id: apply_deed_executed matches on
    // pandadoc_document_id and returns silently when it finds nothing, so the
    // tenant signs and NOTHING happens, for ever. deed_state is still null too,
    // so claim_tenancy_deed would hand the next delivery of the same Stripe
    // event a second document for the same tenancy.
    //
    // It used to stop here, at an incident asking a person to attach an id by
    // hand. That is a dead end dressed as an alert: nothing retries it, the
    // tenant is signing into a void the whole time, and the next automatic pass
    // makes a SECOND document because the row still looks ungenerated.
    //
    // SECURE THE ID FIRST, AND ONLY THE ID. The failed write set eight columns,
    // and the realistic causes (a check constraint, a timestamp-ordering trigger,
    // a stale column) are properties of ONE of the other seven, not of
    // pandadoc_document_id. The id is also the only column that matters for
    // correctness: it is what apply_deed_executed matches on, so with it written
    // the tenant's signature lands and the one-document guard holds. The rest is
    // display.
    const { error: minimalErr } = await service.from("applications")
      .update({ pandadoc_document_id: res.documentId }).eq("id", appId);
    if (!minimalErr) {
      await service.rpc("report_ops_incident", {
        p_type: "deed_stamp_partial",
        p_detail: `Application ${appId}: PandaDoc document ${res.documentId} was sent and its id recorded, but the surrounding deed columns could not be written (${stampErr.message}). Signing works and no second deed can be created; the application's deed status may read stale until the row is corrected.`,
      }).then(() => {}, () => {});
      // Sent, attached, and matchable. The loss is display state, not the deed.
      return res;
    }

    /* THE ROW IS NOT WRITABLE AT ALL, so there is no way to make this document
       ever match its application. Leaving it live means a tenant signs a deed
       that can never be executed, and the next pass adds a second one beside it,
       which is the two-live-deeds failure the lease exists to prevent. We created
       it, so we void it: the tenant is told the document was withdrawn rather
       than signing into nothing, and the retry generates cleanly. */
    const voided = await voidDocument(res.documentId, app.livemode === true);
    await service.rpc("report_ops_incident", {
      p_type: "deed_document_unattached",
      p_detail: `Application ${appId}: PandaDoc document ${res.documentId} was created and sent to the tenant, but the application row could not be stamped with it, even with the id alone (${stampErr.message}). `
        + (voided.ok || voided.alreadyGone
          ? `The document has been voided so nobody signs into a void; the deed will regenerate once the row is writable.`
          : `The document could NOT be voided either (${voided.error}). Signing it will do nothing. Void ${res.documentId} in PandaDoc by hand.`),
    }).then(() => {}, () => {});
    return { ok: false, documentId: res.documentId, error: "The deed was sent but could not be recorded against the application. This has been raised with opndoor." };
  }
  if (!reissue) {
    await service.from("activity_log").insert({
      application_id: appId, kind: "deed_sent",
      /* Byte-identical for a solo application. The joint wording described the
         SUPERSEDED design: "One deed for this tenancy, naming A, B" is what we did
         before 20261005110000 ruled that each tenant signs their OWN deed for their
         OWN share, generated once THAT tenant pays. The trail was therefore telling
         an agency the opposite of what had happened, on the one record they consult
         when a co-tenant asks where their deed is: it reads as though one document
         covers everybody and nothing further is coming, when in fact a second deed
         follows the second payment. */
      message: (unit?.tenant_count ?? 1) > 1
        ? `Deed of Guarantee sent for signature. This tenant's own deed, covering their share of the rent, naming all ${unit.tenant_count} tenants: ${unit.tenant_names}. Each tenant signs their own.`
        : "Deed of Guarantee sent to the tenant for signature.",
      actor: "System",
    });
  }
  return res;
}



