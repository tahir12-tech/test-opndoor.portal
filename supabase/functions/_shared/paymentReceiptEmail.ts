import { sendMessage } from "./mailer.ts";
import { paymentReceiptEmail } from "./emailTemplates.ts";
import { managedByFor, managedByLabel } from "./managedBy.ts";
import { maySendOpndoorEmail } from "./livemodeCredentials.ts";

/* THE AGENCY'S NAME, WHERE WE HAVE ONE. Matt (ag): say "Once you've signed,
   Regent's Lettings receives the signed deed" instead of "the contact on your
   tenancy". Never throws and returns null on anything unexpected, because
   this is a copy decision and a copy decision must not fail a send -- the
   same rule managedByFor already follows. */
async function agencyNameFor(service: any, appId: string): Promise<string | null> {
  try {
    const { data } = await service
      .from("applications")
      .select("agency:agencies(name)")
      .eq("id", appId).maybeSingle();
    const a = data?.agency;
    const name = Array.isArray(a) ? a[0]?.name : a?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/* AND THEIR DOOR TO THE DEED. Matt (ai): PandaDoc now sends nothing, so this
   receipt is the ONLY email telling the tenant there is something to sign.

   THE PAY PAGE TOKEN, not a PandaDoc session URL: it lives for 90 days in an
   inbox and PayLanding mints a fresh signing session on arrival, where a
   session link embedded here would be minted at send time and dead long
   before anybody clicked it.

   A FAILURE HERE DOES NOT STOP THE RECEIPT. Their money has moved and the
   confirmation of that is worth sending on its own; the email simply goes
   without a button, and the signing invite can be re-sent from the
   application. Silence about a payment would be the worse failure. */
async function signUrlFor(service: any, ref: string): Promise<string | null> {
  const base = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
  if (!base) return null;
  try {
    const { data, error } = await service.rpc("mint_payment_page_token", { p_ref: ref });
    // `sign=1`: see signingInvite.ts. This button says "Sign your Deed of
    // Guarantee" and must do exactly that. (be)
    return error || !data ? null : `${base}/pay?token=${data}&sign=1`;
  } catch {
    return null;
  }
}

export async function deliverPaymentReceipt(service: any, p: { appId: string; tenantEmail: string; title: string; lastName: string; propertyAddr: string; amount: string; guaranteeRef: string }): Promise<void> {
  if (!p.tenantEmail) return;

  /* SANDBOX SENDS NO OPNDOOR EMAIL, checked HERE as well as at the call site.
     stripe-webhook already gates this on maySendOpndoorEmail, so today this
     line changes nothing -- and sandboxDoesNotEmailRealPeople caught the
     module anyway, correctly: it reads `applications` and calls sendMessage
     and carried no gate of its own, so the guard could not tell a safe
     caller from a future careless one. The gate belongs where the email
     leaves, not only where it is asked for. */
  const { data: row } = await service
    .from("applications").select("livemode").eq("id", p.appId).maybeSingle();
  if (!maySendOpndoorEmail(row?.livemode === true)) return;
  // Says "your letting agent" or "your landlord" from what the tenant told us,
  // rather than assuming. managedByFor never throws: a copy decision must not
  // fail a send.
  const res = await sendMessage({
    to: p.tenantEmail,
    message: paymentReceiptEmail({
      propertyAddr: p.propertyAddr, guaranteeRef: p.guaranteeRef, amount: p.amount,
      managedBy: managedByLabel(await managedByFor(service, p.appId)),
      agencyName: await agencyNameFor(service, p.appId),
      signUrl: await signUrlFor(service, p.guaranteeRef),
    }),
  });
  await service.from("activity_log").insert({
    application_id: p.appId,
    kind: res.ok ? "payment_receipt_sent" : "payment_receipt_failed",
    message: res.ok ? "Payment receipt sent to the tenant." : `Payment receipt not sent: ${res.error}`,
    actor: "System",
    visibility: res.ok ? "business" : "internal",
  });
  if (res.ok && res.to && res.to !== p.tenantEmail) {
    await service.from("activity_log").insert({
      application_id: p.appId, kind: "payment_receipt_sent",
      message: `Payment receipt delivered to ${res.to}.`, actor: "System", visibility: "internal",
    });
  }
}
