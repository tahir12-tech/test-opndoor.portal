import { sendMessage, bytesToBase64, type Attachment } from "./mailer.ts";
import { executedDeedTenantEmail } from "./emailTemplates.ts";
import { correctedFromLabel, formatTenancyStart } from "./deedEmail.ts";

export async function deliverExecutedDeedToTenant(service: any, p: { appId: string; ref: string; tenantEmail: string; tenantName: string; propertyAddr: string; tenancyStart: string | null; pdfPath: string | null }): Promise<void> {
  if (!p.tenantEmail) return;
  // The tenant's own signed copy rides as an ATTACHMENT now, not a download link.
  // The PDF is already in the deeds bucket (the completion webhook uploads it just
  // before this send). A missing PDF is left to the agent send's own note, since
  // both fire for the same application in the same webhook.
  const attachments: Attachment[] = [];
  if (p.pdfPath) {
    const { data: blob } = await service.storage.from("deeds").download(p.pdfPath);
    if (blob) {
      attachments.push({
        filename: `Deed of Guarantee ${p.ref}.pdf`,
        content: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
      });
    }
  }
  const res = await sendMessage({
    to: p.tenantEmail,
    message: executedDeedTenantEmail({
      guaranteeRef: p.ref, propertyAddr: p.propertyAddr,
      tenancyStartLabel: formatTenancyStart(p.tenancyStart),
      // "Same for the tenant's copy", Matt, 2026-10-01.
      correctedFrom: await correctedFromLabel(service, p.appId),
    }),
    attachments,
  });
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
      message: `Signed deed email delivered to ${res.to}.`, actor: "System", visibility: "internal",
    });
  }
}
