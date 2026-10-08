// =====================================================================
// amend-tenancy-start (verify_jwt = true)
//
// Single server entry point for amending the tenancy start date. Permission is
// enforced by the amend_tenancy_start RPC (deed-state aware, AAL2, ownership),
// called as the signed-in user. After the date update, the deed lifecycle and its
// activity trail are the shared reissueDeedForAmendment helper, run with the
// service role, so this staff path and the agent self-serve path
// (tenancy-correction) cannot drift apart.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { notifyReferrer } from "../_shared/referrerNotify.ts";
import { voidDocument, generateDeed } from "../_shared/pandadoc.ts";
import { deliverSigningInvite } from "../_shared/signingInvite.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** yyyy-mm-dd (or ISO) -> dd/mm/yyyy for the activity message. */
/* "16 Oct 2026", not "16/10/2026". Matt, 2026-10-04: 'use "16 Oct 2026"
   format'. This is the portal's one date format, and an audit row a human
   reads a year later should not need the reader to know whether we write
   days or months first. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dmy(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  const mi = Number(m[2]) - 1;
  return `${Number(m[3])} ${MONTHS[mi] ?? m[2]} ${m[1]}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ ok: false, error: "Not authenticated." }, 401);

    const { ref, newStart, confirmReissue } = await req.json();
    if (!ref || !newStart) return json({ ok: false, error: "Missing application reference or new start date." }, 400);

    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    /* WHO CHANGED IT, AND "BY OPNDOOR" WHEN IT WAS US.

       Matt (bm): "when Opndoor staff make a change (start date,
       withdrawal, anything), say 'by opndoor', never the staff member's
       name."

       IT IS A PRIVACY RULE AS MUCH AS A COPY ONE. An agency has no
       business knowing which of us touched their record, and naming one
       invites them to ask for that person next time.

       ONE PLACE, because `actor` reaches five sentences from here: two
       activity messages, the activity rows' own actor column, the
       "corrected deed sent" line through deliverSigningInvite, and the
       referrer's "the tenancy start date has changed ... by X" email.
       Rewriting those five would be five chances to miss one.

       AND NOT FOR A CUSTOMER'S OWN PEOPLE. An agency Manager amending
       their own referral is still named: that is a colleague, and the
       agency has every reason to know which of them moved a date. The
       rule is about us, so the test is is_opndoor_staff() -- asked of
       the database rather than recomputed from role strings here, so
       this cannot drift from the definition the rest of the product
       authorises with. */
    let actor = "A user";
    if (userData.user?.id) {
      const { data: isStaff } = await userClient.rpc("is_opndoor_staff");
      if (isStaff === true) {
        actor = "opndoor";
      } else {
        const { data: prof } = await userClient.from("users").select("full_name").eq("id", userData.user.id).maybeSingle();
        if (prof?.full_name) actor = prof.full_name;
      }
    }

    // RLS-scoped read of the pre-amend state (drives the deed orchestration and
    // gives the OLD tenancy start for the activity message).
    const { data: app, error: readErr } = await userClient
      .from("applications")
      .select("id, guarantee_ref, status, deed_state, pandadoc_document_id, executed_pdf_path, tenancy_start, livemode, "
        // See the same addition in tenancy-correction: the update below
        // moves these aside, so they have to be in hand.
        + "deed_delivered_at, deed_delivered_to, deed_delivery_superseded_at, deed_delivery_superseded_to")
      .eq("guarantee_ref", ref)
      .maybeSingle();
    if (readErr) return json({ ok: false, error: readErr.message }, 400);
    if (!app) return json({ ok: false, error: "Application not found, or you do not have access to it." }, 404);

    const oldDmy = dmy(app.tenancy_start);
    const newDmy = dmy(newStart);
    const dateChange = `from ${oldDmy} to ${newDmy}`;

    /* A DATE THAT IS NOT MOVING IS NOT AN AMENDMENT.

       Matt, 2026-10-04: the activity log said "amended from 17/10/2026 to
       17/10/2026". It was not a read-after-write: `oldDmy` is taken above,
       before the RPC. It was this function running TWICE, and the log on dev
       proves it. Two tenancy_amended rows six seconds apart:

         17:00:21  tenancy_amended  from 17/10/2026 to 17/10/2026
         17:00:21  deed_voided      ... amendment from 16/10/2026 ...
         17:00:27  tenancy_amended  from 16/10/2026 to 17/10/2026

       One call read 16 and moved it, taking six seconds over voiding and
       regenerating the deed. A second call, arriving while the first was
       still working, read the date the first had ALREADY WRITTEN, found
       nothing to do, and logged that it had done it. The correct row is the
       17:00:27 one; the meaningless one was written first and is the one a
       reader sees at the top.

       SO THE GUARD IS THE RULE ITSELF rather than a lock: amending a date to
       the date it already has is a no-op, and a no-op writes no audit row,
       voids no deed and sends no email. That is true whatever caused the
       second call -- a double click, a retry, two tabs -- and it is worth
       saying even with one caller. */
    if (app.tenancy_start === newStart) {
      return json({ ok: true, unchanged: true, message: "That is already the tenancy start date, so nothing was changed." });
    }

    // #82 Amending a SIGNED (executed) deed is destructive: it voids/supersedes the
    // signed deed, reissues it to the tenant, and re-notifies the agent once
    // re-signed. Require an explicit confirmation BEFORE the date is committed.
    if (isExecutedDeed(app) && confirmReissue !== true) {
      return json({ ok: false, needsConfirm: true, error: "Amending the tenancy start on a signed deed will void it, reissue a corrected deed to the tenant to sign, and re-notify the agent once re-signed. Confirm to proceed." }, 200);
    }

    // 1) Permission + date update, enforced in the database (deed-state aware).
    const { error: rpcErr } = await userClient.rpc("amend_tenancy_start", { p_app: app.id, p_new_start: newStart });
    if (rpcErr) {
      return json({ ok: false, error: "Could not amend the tenancy start date." }, 200);
    }

    const service = createClient(SUPABASE_URL, SERVICE);

    // #81 The date is now amended, so any agent-reported tenancy-start corrections
    // for this application are handled; mark them resolved (best-effort).
    await service.from("tenancy_correction_tokens")
      .update({ resolved_at: new Date().toISOString(), resolved_by: userData.user?.id ?? null })
      .eq("application_id", app.id).is("resolved_at", null).not("submitted_at", "is", null);

    // Exactly one BUSINESS activity entry per amend, attributed by name, stating
    // old -> new. "The deed was reissued for signing" is appended ONLY when a
    // regeneration actually ran. Supporting steps (archive / void) are separate:
    // the archive entry references the amend; the void is an internal detail.
    /* PER APPLICATION, because each tenant's record needs its own audit of
       the change to their own tenancy start. One notice to the referrer;
       one activity row each. */
    const logAmend = (appId: string, suffix: string) =>
      service.from("activity_log").insert({
        application_id: appId, kind: "tenancy_amended",
        message: `Tenancy start amended ${dateChange} by ${actor}.${suffix}`,
        actor, visibility: "business",
      });

    /** One applicant's deed, from whatever state the amend caught it in.
     *  Returns rather than replies: on a joint tenancy there are several of
     *  these and only one HTTP answer. */
    // deno-lint-ignore no-explicit-any
    const amendOne = async (a: any): Promise<{ ok: boolean; reissued: boolean; error?: string }> => {
    if (a.deed_state === "executed" || a.status === "deed") {
      // Archive the signed PDF before replacing it (the entry references the amend).
      // Only claim an archive when there actually was a stored PDF to archive.
      const archived = !!a.executed_pdf_path;
      if (archived) {
        const archivePath = `${a.id}/archive/${a.guarantee_ref}-superseded-${a.pandadoc_document_id ?? "deed"}.pdf`;
        await service.storage.from("deeds").copy(a.executed_pdf_path, archivePath);
        await service.from("activity_log").insert({ application_id: a.id, kind: "deed_archived", message: `Signed deed archived before amending the tenancy start ${dateChange}, by ${actor}.`, actor, visibility: "business" });
      }
      const archivePhrase = archived ? "The signed deed was archived and a" : "A";
      // Reopen to Paid and clear the executed deed, then issue a replacement.
      /* AND THE DELIVERY GOES WITH THE DEED. 20261007640000.
         This update cleared everything about the executed document and
         left `deed_delivered_at` pointing at the delivery of the deed it
         had just archived, so the application went on claiming a
         delivery of a superseded PDF -- and the completion guard, asking
         "has this been delivered", refused the corrected deed as a
         replay. GR-23853: signed 03 Oct 11:28:43, "Completion replayed;
         the signed deed already went to joe", and the agent never got
         it. The earlier delivery is MOVED rather than dropped: it really
         happened, the agent holds that PDF, and the Delivery panel has
         to be able to say it is superseded. */
      await service.from("applications").update({
        status: "paid", deed_state: null, deed_issued_at: null, deed_executed_at: null,
        issue_date: null, executed_pdf_path: null, pandadoc_document_id: null, deed_viewed_at: null,
        deed_delivery_superseded_at: a.deed_delivered_at ?? a.deed_delivery_superseded_at ?? null,
        deed_delivery_superseded_to: a.deed_delivered_to ?? a.deed_delivery_superseded_to ?? null,
        deed_delivered_at: null, deed_delivered_to: null, deed_resent_at: null,
      }).eq("id", a.id);
      const gen = await generateDeed(service, a.id, true);
      if (!gen.ok) {
        // The date change already committed: always leave exactly one amend entry,
        // without a reissue clause (no regeneration ran).
        await logAmend(a.id, `${archived ? " The signed deed was archived." : ""} The replacement deed could not be issued automatically; opndoor has been notified.`);
        return { ok: false, reissued: false, error: `the replacement deed for ${a.guarantee_ref} failed: ${gen.error}` };
      }
      /* AND OPNDOOR SENDS THE SIGNING EMAIL. Matt (ai): "Check the
         corrected-deed flow (start-date changes) also uses Opndoor's
         email." Since `silent: true`, generateDeed issues the document and
         PandaDoc tells nobody, so without this the tenant is never asked to
         sign the corrected deed and the two copies disagree about the date
         for ever.

         BEST EFFORT, AFTER the deed exists. The date change and the
         regeneration have both committed by here; a failure to EMAIL must
         not report the amendment as failed, because it did not. It is
         logged by deliverSigningInvite and the agent can press Resend. */
      await deliverSigningInvite(service, a.id, { reissue: true, by: actor });
      await logAmend(a.id, ` ${archivePhrase} replacement was reissued for signing.`);
      /* THE REFERRER'S NOTICE USED TO BE SENT HERE and has moved out of
         this function entirely. Its original reasoning still holds and is
         kept where it now lives: the type has been in the preference matrix
         since 20261006510000 with nothing ever sending it, and notifyReferrer
         applies the matrix so who hears is their setting rather than this
         code's opinion.

         WHAT CHANGED IS THE GRAIN. Matt (bn): the referrer gets ONE email
         for the tenancy listing every tenant. Left in this branch it would
         fire once per sibling the moment a joint tenancy went through -- the
         same duplicate-notice fault as (bc), reintroduced by the loop. */
      return { ok: true, reissued: true };
    }

    if (a.deed_state === "awaiting_tenant" && a.pandadoc_document_id) {
      // #82 one-live-deed invariant: the outstanding unsigned deed must ALWAYS be
      // replaced with a corrected one so the deed and the amended date can never
      // disagree. The void of the old PandaDoc envelope is BEST-EFFORT: clear the
      // document id first (so any late webhook for the old document is inert), then
      // attempt the void, then regenerate regardless of the void outcome. A failed
      // void never blocks the amend, because the new deed supersedes the old one.
      const oldDocId = a.pandadoc_document_id;
      await service.from("applications").update({ pandadoc_document_id: null, deed_state: null, deed_viewed_at: null }).eq("id", a.id);
      // livemode from the application row, so an amendment on a sandbox deed voids
      // it in the sandbox PandaDoc account rather than 404ing against production.
      const voided = await voidDocument(oldDocId, a.livemode === true);
      await service.from("activity_log").insert({
        application_id: a.id, kind: "deed_voided",
        message: voided.ok
          ? `Outstanding deed voided for a tenancy-start amendment ${dateChange} by ${actor}.`
          : `Outstanding deed could not be voided for a tenancy-start amendment ${dateChange}; it is superseded by the regenerated deed. Detail: ${voided.error}`,
        actor, visibility: "internal",
      });
      const gen = await generateDeed(service, a.id, true);
      if (!gen.ok) {
        // Date change committed; the deed is left in 'error' (not live) so the
        // invariant still holds. Log the amend without a reissue clause.
        await logAmend(a.id, " The corrected deed could not be issued automatically; opndoor has been notified.");
        return { ok: false, reissued: false, error: `the corrected deed for ${a.guarantee_ref} failed: ${gen.error}` };
      }
      /* AND OPNDOOR SENDS THE SIGNING EMAIL. Matt (ai): "Check the
         corrected-deed flow (start-date changes) also uses Opndoor's
         email." Since `silent: true`, generateDeed issues the document and
         PandaDoc tells nobody, so without this the tenant is never asked to
         sign the corrected deed and the two copies disagree about the date
         for ever.

         BEST EFFORT, AFTER the deed exists. The date change and the
         regeneration have both committed by here; a failure to EMAIL must
         not report the amendment as failed, because it did not. It is
         logged by deliverSigningInvite and the agent can press Resend. */
      await deliverSigningInvite(service, a.id, { reissue: true, by: actor });
      // Audit line the ruling requires, kept as an INTERNAL supporting step so the
      // single business tenancy_amended entry (below) is the only partner-visible
      // row, matching the executed branch and the one-business-entry-per-amend rule.
      /* BUSINESS, NOT INTERNAL. Matt, 2026-10-04: "Yes, show 'Deed
         regenerated' in the activity log." He had reported seeing no new
         "sent for signature" entry after an amendment; there was one, and it
         was invisible to him.

         A TENANT BEING ASKED TO SIGN AGAIN IS SOMETHING THE AGENT IS
         ANSWERABLE FOR. The tenancy_amended row says the date moved; it does
         not say a fresh signature is now outstanding, which is the part
         somebody has to chase. The message says who it went to rather than
         just that it happened. */
      await service.from("activity_log").insert({ application_id: a.id, kind: "deed_regenerated", message: "A corrected Deed of Guarantee was sent to the tenant to sign.", actor, visibility: "business" });
      await logAmend(a.id, " The outstanding deed was replaced with a corrected one for signing.");
      return { ok: true, reissued: true };
    }

    // Sent, or Paid with no live deed (error / declined / voided / none): no reissue.
    await logAmend(a.id, "");
    return { ok: true, reissued: false };
    };

    /* 2) THE DEED LIFECYCLE, FOR EVERY TENANT ON THE TENANCY.
     *
     * Matt (bn), a blocker: "Changing Jane's start date (20 Nov -> 29 Nov)
     * reissued only Jane's deed; John got no corrected-deed email. On a
     * joint tenancy, a start-date change must move every tenant's date
     * together and reissue every tenant's deed (signed or not)."
     *
     * THE DATE DID MOVE, WHICH MAKES THIS WORSE THAN IT LOOKS. Measured on
     * dev before changing anything: GR-26262 and GR-26263 both read
     * 2026-11-29 with expiries of 2027-11-28, so `amend_tenancy_start` had
     * done its job -- it has moved the whole tenancy since 20261006860000.
     * What stayed behind was the INSTRUMENT. John's deed is still
     * `executed`, signed, and states 20 November, while the row it belongs
     * to says the 29th and the expiry is generated from the row. One signed
     * deed disagreeing with its own application, on the bordereau.
     *
     * EACH SIBLING IS IN ITS OWN STATE, which is why this is a loop over the
     * same branches rather than a repeat of one outcome: on this very
     * tenancy Jane was awaiting signature and John had signed, so one needed
     * a void-and-regenerate and the other an archive-and-reissue.
     */
    const { data: family } = await service
      .from("applications")
      .select("id, guarantee_ref, status, deed_state, executed_pdf_path, pandadoc_document_id, livemode, deed_delivered_at, deed_delivered_to, tenancy_position")
      .or(app.tenancy_id ? `tenancy_id.eq.${app.tenancy_id}` : `id.eq.${app.id}`)
      .order("tenancy_position", { ascending: true });
    /* THE AMENDED APPLICATION IS ALWAYS IN THE LIST, even if the read above
       returns nothing: a start-date change that silently reissued no deeds
       at all would be the same class of failure in the other direction. */
    const siblings = (family && family.length ? family : [app]) as Array<typeof app>;

    const outcomes = [];
    for (const a of siblings) {
      outcomes.push(await amendOne(a));
    }
    const reissued = outcomes.filter((o) => o.reissued).length;
    const failures = outcomes.filter((o) => !o.ok);

    /* ONE NOTICE FOR THE TENANCY, not one per tenant. Matt (bn): "the
       referrer (and anyone copied) gets ONE 'start date changed' email for
       the tenancy listing every tenant". It used to sit inside each branch,
       which on a joint tenancy would now send it two or three times -- the
       same fault (bc) was about, reintroduced by the loop if it were left
       where it was. Sent against the amended application, which is the one
       the referrer acted on. */
    await notifyReferrer(service, app.id, "corrected", {
      oldDate: oldDmy, newDate: newDmy, by: actor, deedReissued: reissued > 0,
    });

    if (failures.length) {
      return json({ ok: false, error: `Tenancy start amended, but ${failures.map((f) => f.error).join("; ")}.` }, 200);
    }
    if (reissued === 0) return json({ ok: true, message: "Tenancy start amended." });
    return json({
      ok: true,
      message: siblings.length > 1
        ? `Tenancy start amended for all ${siblings.length} tenants, and ${reissued === 1 ? "one corrected deed was" : `${reissued} corrected deeds were`} sent for signing.`
        : "Tenancy start amended, and a corrected deed was sent to the tenant to sign.",
    });
  } catch (e) {
    return json({ ok: false, error: "Could not amend the tenancy start date." }, 500);
  }
});
