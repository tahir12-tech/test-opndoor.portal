import { sendMessage } from "./mailer.ts";
import { refundEmail, guaranteesCancelledEmail } from "./emailTemplates.ts";

export async function deliverRefund(service: any, p: { appId: string; tenantEmail: string; title: string; lastName: string; propertyAddr: string; amount: string; guaranteeRef: string; deedCancelled?: boolean; cascaded?: boolean }): Promise<void> {
  if (!p.tenantEmail) return;
  const res = await sendMessage({
    to: p.tenantEmail,
    message: refundEmail({ propertyAddr: p.propertyAddr, guaranteeRef: p.guaranteeRef, amount: p.amount, deedCancelled: p.deedCancelled, cascaded: p.cascaded }),
  });
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
      message: `Refund confirmation email delivered to ${res.to}.`, actor: "System", visibility: "internal",
    });
  }
}

/* ONE EMAIL TO THE PROPERTY, not one per tenant.
 *
 * Matt (al): "the agent (and any landlord sent a deed) gets one email listing
 * every tenant on the tenancy and saying all guarantees for the property are
 * cancelled."
 *
 * WHO GETS IT IS A SQL QUESTION and is answered by
 * guarantee_cancellation_notice: the distinct inboxes a deed was actually
 * DELIVERED to, plus any landlord one was sent to. Not the branch's current
 * contact list, which on a let that fell through three weeks ago is somebody
 * who has never heard of this tenancy.
 *
 * NOBODY IS THE COMMON ANSWER and it is not a failure. A tenancy refunded
 * before any deed went out has no agent delivery and no landlord, and the
 * right thing to do is send nothing.
 *
 * THE LOG ROW GOES ON THE TRIGGER APPLICATION, once, because the email went
 * once. Writing it to every sibling would tell three screens that three
 * emails had gone.
 */
export async function deliverCancellationNotice(service: any, appId: string, guaranteeRef: string): Promise<void> {
  const { data, error } = await service.rpc("guarantee_cancellation_notice", { p_application: appId });
  if (error) {
    await service.from("activity_log").insert({
      application_id: appId, kind: "cancellation_notice_failed",
      message: `Could not work out who to tell about the cancellation: ${error.message}`,
      actor: "System", visibility: "internal",
    });
    return;
  }
  const n = (Array.isArray(data) ? data[0] : data) as {
    property: string; agent_emails: string[] | null; landlord_email: string | null;
    landlord_name: string | null; tenants: Array<{ name: string; guaranteeRef: string }>;
  } | null;
  if (!n) return;

  const tenants = n.tenants ?? [];
  const agents = (n.agent_emails ?? []).filter(Boolean);
  if (!agents.length && !n.landlord_email) {
    await service.from("activity_log").insert({
      application_id: appId, kind: "cancellation_notice_skipped",
      message: "No deed had been delivered to anybody, so there was nobody to tell that it was cancelled.",
      actor: "System", visibility: "internal",
    });
    return;
  }

  const sent: string[] = [];
  const failed: string[] = [];

  if (agents.length) {
    /* EVERY INBOX ON ONE MESSAGE, which `sendMessage` takes as an array and
       `resolveRecipients` redirects wholesale in test mode. Two agents at the
       branch each receiving their own cancellation for one property would
       each think they had the whole story; on one message they can see it is
       the property, not their tenant. */
    const res = await sendMessage({
      to: agents,
      message: guaranteesCancelledEmail({ propertyAddr: n.property, tenants, audience: "agent" }),
    });
    (res.ok ? sent : failed).push(agents.join(", "));
  }

  if (n.landlord_email) {
    /* A SEPARATE MESSAGE, NOT A COPY. The landlord gets different closing
       wording -- they are told to speak to the agent, not to us -- and
       putting them on the agent's email would show the agent's address book
       to the landlord and vice versa. */
    const res = await sendMessage({
      to: n.landlord_email,
      message: guaranteesCancelledEmail({ propertyAddr: n.property, tenants, audience: "landlord" }),
    });
    (res.ok ? sent : failed).push(n.landlord_email);
  }

  await service.from("activity_log").insert({
    application_id: appId,
    kind: failed.length ? "cancellation_notice_failed" : "cancellation_notice_sent",
    message: failed.length
      ? `Cancellation notice could not be sent to ${failed.join(", ")}.`
      /* "BOTH TENANTS", NOT "ALL 2 TENANTS". Matt (az). The countOf idiom
         this estate uses elsewhere has a case for two and this sentence was
         built by hand without it. "All 2" is the kind of phrasing that
         tells a reader a machine wrote the line. */
      : `Cancellation notice sent to ${sent.join(", ")}, listing ${
          tenants.length === 1 ? "1 tenant"
          : tenants.length === 2 ? "both tenants"
          : `all ${tenants.length} tenants`} on the tenancy.`,
    actor: "System",
    visibility: failed.length ? "internal" : "business",
  });
}
