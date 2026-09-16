// =====================================================================
// Deed lifecycle for a tenancy-start amendment, shared by the staff path
// (amend-tenancy-start, after the audited amend_tenancy_start RPC) and the agent
// path (tenancy-correction, the tokenised link in the deed-delivery email).
//
// The date is already committed by the caller when this runs. Keyed on the deed
// state at amend time:
//   - executed        : archive the signed PDF, reopen to Paid, and issue a
//                       replacement deed for the tenant to sign;
//   - awaiting_tenant : void the outstanding document and regenerate, so the
//                       corrected tenancy start prints on a fresh deed;
//   - otherwise (Sent, or Paid with no live deed): nothing to reissue.
//
// Exactly one BUSINESS activity entry is written per amend, attributed by name,
// stating old -> new. "The deed was reissued for signing" is appended ONLY when a
// regeneration actually ran. Supporting steps (archive / void) are separate: the
// archive entry references the amend; the void is an internal detail.
// =====================================================================
// deno-lint-ignore-file no-explicit-any
import { voidDocument, generateDeed } from "./pandadoc.ts";

/** The pre-amend application state the lifecycle is keyed on. */
export interface AmendTarget {
  id: string;
  guarantee_ref: string;
  status: string | null;
  deed_state: string | null;
  pandadoc_document_id: string | null;
  executed_pdf_path: string | null;
}

export interface ReissueOutcome {
  /** false only when a regeneration was required and failed (the date still stands). */
  ok: boolean;
  /** Caller-facing summary of what happened. */
  message: string;
  error?: string;
}

/** True when the deed is signed and issued, so amending is destructive. */
export function isExecutedDeed(app: { status: string | null; deed_state: string | null }): boolean {
  return app.deed_state === "executed" || app.status === "deed";
}

/**
 * Run the deed lifecycle for an already-committed tenancy-start amendment and
 * write the activity trail. `actor` names who amended ("Agent" on the tokenised
 * agent path); `dateChange` is the "from dd/mm/yyyy to dd/mm/yyyy" phrase.
 */
export async function reissueDeedForAmendment(
  service: any,
  app: AmendTarget,
  actor: string,
  dateChange: string,
  /** How the actor is named in message text; defaults to `actor`. */
  actorLabel: string = actor,
): Promise<ReissueOutcome> {
  const logAmend = (suffix: string) =>
    service.from("activity_log").insert({
      application_id: app.id, kind: "tenancy_amended",
      message: `Tenancy start amended ${dateChange} by ${actorLabel}.${suffix}`,
      actor, visibility: "business",
    });

  if (isExecutedDeed(app)) {
    // Archive the signed PDF before replacing it (the entry references the amend).
    // Only claim an archive when there actually was a stored PDF to archive.
    const archived = !!app.executed_pdf_path;
    if (archived) {
      const archivePath = `${app.id}/archive/${app.guarantee_ref}-superseded-${app.pandadoc_document_id ?? "deed"}.pdf`;
      await service.storage.from("deeds").copy(app.executed_pdf_path, archivePath);
      await service.from("activity_log").insert({ application_id: app.id, kind: "deed_archived", message: `Signed deed archived before amending the tenancy start ${dateChange}, by ${actorLabel}.`, actor, visibility: "business" });
    }
    const archivePhrase = archived ? "The signed deed was archived and a" : "A";
    // Reopen to Paid and clear the executed deed, then issue a replacement.
    await service.from("applications").update({
      status: "paid", deed_state: null, deed_issued_at: null, deed_executed_at: null,
      issue_date: null, executed_pdf_path: null, pandadoc_document_id: null, deed_viewed_at: null,
    }).eq("id", app.id);
    const gen = await generateDeed(service, app.id, true);
    if (!gen.ok) {
      // The date change already committed: always leave exactly one amend entry,
      // without a reissue clause (no regeneration ran).
      await logAmend(`${archived ? " The signed deed was archived." : ""} The replacement deed could not be issued automatically; opndoor has been notified.`);
      return { ok: false, message: "", error: `Tenancy start amended${archived ? " and the signed deed archived" : ""}, but the replacement failed: ${gen.error}` };
    }
    await logAmend(` ${archivePhrase} replacement was reissued for signing.`);
    return { ok: true, message: `Tenancy start amended.${archived ? " The signed deed was archived and a replacement" : " A replacement deed was"} sent to the tenant to sign.` };
  }

  if (app.deed_state === "awaiting_tenant" && app.pandadoc_document_id) {
    // #82 one-live-deed invariant: the outstanding unsigned deed must ALWAYS be
    // replaced with a corrected one so the deed and the amended date can never
    // disagree. The void of the old PandaDoc envelope is BEST-EFFORT: clear the
    // document id first (so any late webhook for the old document is inert), then
    // attempt the void, then regenerate regardless of the void outcome. A failed
    // void never blocks the amend, because the new deed supersedes the old one.
    const oldDocId = app.pandadoc_document_id;
    await service.from("applications").update({ pandadoc_document_id: null, deed_state: null, deed_viewed_at: null }).eq("id", app.id);
    const voided = await voidDocument(oldDocId);
    await service.from("activity_log").insert({
      application_id: app.id, kind: "deed_voided",
      message: voided.ok
        ? `Outstanding deed voided for a tenancy-start amendment ${dateChange} by ${actorLabel}.`
        : `Outstanding deed could not be voided for a tenancy-start amendment ${dateChange}; it is superseded by the regenerated deed. Detail: ${voided.error}`,
      actor, visibility: "internal",
    });
    const gen = await generateDeed(service, app.id, true);
    if (!gen.ok) {
      // Date change committed; the deed is left in 'error' (not live) so the
      // invariant still holds. Log the amend without a reissue clause.
      await logAmend(" The corrected deed could not be issued automatically; opndoor has been notified.");
      return { ok: false, message: "", error: `Tenancy start amended, but the corrected deed failed: ${gen.error}` };
    }
    // Audit line the ruling requires, kept as an INTERNAL supporting step so the
    // single business tenancy_amended entry (below) is the only partner-visible
    // row, matching the executed branch and the one-business-entry-per-amend rule.
    await service.from("activity_log").insert({ application_id: app.id, kind: "deed_regenerated", message: "Deed regenerated after tenancy amendment.", actor, visibility: "internal" });
    await logAmend(" The outstanding deed was replaced with a corrected one for signing.");
    return { ok: true, message: "Tenancy start amended. The outstanding deed was replaced with a corrected one." };
  }

  // Sent, or Paid with no live deed (error / declined / voided / none): no reissue.
  await logAmend("");
  return { ok: true, message: "Tenancy start amended." };
}
