// =====================================================================
// tenancy-correction (verify_jwt = false)
//
// Public token exchange for #81. An agent opens the tokenised link from the
// executed-deed email, sees the guarantee reference and the current tenancy
// start, and enters the correct date. Submitting APPLIES the correction
// automatically: the corrected date is written, the outstanding or executed deed
// is voided (a signed PDF is archived first), a corrected deed is regenerated and
// sent to the tenant to sign again, and once they sign the agent receives the new
// executed deed automatically (the completion webhook re-fires for the new
// document id). It is logged as an agent correction. There is no opndoor review.
//
// The deed lifecycle mirrors amend-tenancy-start's (the staff path), keyed on the
// deed state, and reuses the same shared primitives (voidDocument / generateDeed).
// It runs with the SERVICE ROLE because the agent has no login: amend_tenancy_start
// is gated on AAL2 + ownership and cannot be reached from here.
//
// The token is a random uuid scoped to one deed, expiring 7 days after delivery.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { voidDocument, generateDeed } from "../_shared/pandadoc.ts";
import { deliverSigningInvite } from "../_shared/signingInvite.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** yyyy-mm-dd (or ISO) -> dd/mm/yyyy for display. */
/* "29 Dec 2026", the way the rest of the product writes a date. Matt,
   2026-10-01: "Show dates as '29 Dec 2026', including in the PandaDoc
   email text." This page is where somebody corrects a date that is
   already wrong, so a format that can be read two ways is the last thing
   it should print. The month table is written out for the reason
   src/lib/format.ts carries one: Node's en-GB gives "Sept". */
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dmy(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  return `${Number(m[3])} ${MONTH_SHORT[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Same range guard the amend_tenancy_start RPC applies on the staff path. */
function outOfRange(isoDate: string): boolean {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(t)) return true;
  const fiveYears = Date.now() + 5 * 365.25 * 24 * 60 * 60 * 1000;
  return t < Date.parse("2000-01-01T00:00:00Z") || t > fiveYears;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const b = await req.json().catch(() => ({}));
    const token = String(b.token ?? "").trim();
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return json({ ok: false, error: "This link is not valid." }, 200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tok } = await service.from("tenancy_correction_tokens")
      .select("token, application_id, guarantee_ref, expires_at, submitted_at, applications(id, guarantee_ref, status, deed_state, pandadoc_document_id, executed_pdf_path, payment_state, withdrawn_at, tenancy_start, prop_addr1, prop_postcode)")
      .eq("token", token).maybeSingle() as { data: any };
    if (!tok) return json({ ok: false, error: "This link is not valid." }, 200);
    if (new Date(tok.expires_at).getTime() < Date.now()) return json({ ok: false, expired: true, error: "This link has expired." }, 200);

    const app = Array.isArray(tok.applications) ? tok.applications[0] : tok.applications;
    const property = [app?.prop_addr1, app?.prop_postcode].filter(Boolean).join(", ");

    if (b.action === "load") {
      /* WHO IS ON THIS TENANCY, so the page can name them before anybody
         presses the button. Matt, 2026-10-01: "before submitting, say 'We
         will void the current deeds and send each tenant on this tenancy a
         corrected deed to sign', followed by their names."

         Read here rather than on the page: the page holds a token and
         nothing else, and this endpoint is the only thing that can turn
         one into a tenancy without a login. */
      const { data: self } = await service.from("applications")
        .select("tenancy_id").eq("id", tok.application_id).maybeSingle();
      let tenants: string[] = [];
      if (self?.tenancy_id) {
        const { data: mates } = await service.from("applications")
          .select("tenant_first_name, tenant_last_name, tenancy_position")
          .eq("tenancy_id", self.tenancy_id).order("tenancy_position");
        tenants = ((mates ?? []) as Array<{ tenant_first_name: string; tenant_last_name: string }>)
          .map((m) => `${m.tenant_first_name ?? ""} ${m.tenant_last_name ?? ""}`.trim())
          .filter(Boolean);
      }
      return json({ ok: true, guaranteeRef: tok.guarantee_ref, currentStart: dmy(app?.tenancy_start ?? null), property, alreadySubmitted: !!tok.submitted_at, tenants });
    }

    if (b.action === "submit") {
      const proposed = String(b.proposedStart ?? "").trim(); // yyyy-mm-dd
      if (!/^\d{4}-\d{2}-\d{2}$/.test(proposed)) return json({ ok: false, error: "Enter a valid date." }, 200);
      // Range check mirrors amend_tenancy_start's (2000-01-01 .. today + 5 years):
      // the service-role write below bypasses that RPC, so its guard is repeated here.
      const proposedMs = Date.parse(`${proposed}T00:00:00Z`);
      const minMs = Date.parse("2000-01-01T00:00:00Z");
      const maxMs = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;
      if (Number.isNaN(proposedMs) || proposedMs < minMs || proposedMs > maxMs) {
        return json({ ok: false, error: "That date is out of range." }, 200);
      }
      const note = String(b.note ?? "").trim().slice(0, 500) || null;

      // Full deed state for the lifecycle decision. Read with the service role:
      // the token is the authorisation here, there is no signed-in user.
      const COLS = "id, guarantee_ref, status, deed_state, pandadoc_document_id, executed_pdf_path, tenancy_start, livemode, withdrawn_at, tenancy_id, tenant_first_name, tenant_last_name, "
        // The delivery columns, because a correction moves the old deed's
        // delivery aside (20261007640000). Selected rather than assumed: a
        // column the update references and the select omits reads as
        // undefined, which would write null and silently lose the
        // superseded delivery this change exists to keep.
        + "deed_delivered_at, deed_delivered_to, deed_delivery_superseded_at, deed_delivery_superseded_to";
      const { data: full } = await service.from("applications")
        .select(COLS)
        .eq("id", tok.application_id).maybeSingle();
      if (!full) return json({ ok: false, error: "This link is not valid." }, 200);

      /* Q1. A CORRECTION MOVES THE WHOLE TENANCY, OR IT MOVES NOTHING.
         Matt, 2026-09-30: "a start-date correction on a joint tenancy moves
         every tenant's application and reissues every deed, never one."

         R5 (20261006860000) made the STAFF path do this and said why: one
         corrected application of a joint let leaves "two executed
         instruments stating different start dates for the same let", and
         `expiry_date` is GENERATED from `tenancy_start`, so the
         discrepancy reaches the underwriter on the bordereau. This path
         never went through that RPC -- it cannot, the RPC needs AAL2 and a
         caller and the agent has neither -- so it moved one row by id.

         `tenancy_id` is nullable and most applications have none. A solo
         application is a set of one, which keeps every step below
         identical for both cases rather than forking them. */
      const siblings = full.tenancy_id
        ? ((await service.from("applications").select(COLS)
              .eq("tenancy_id", full.tenancy_id)).data ?? [full])
        : [full];
      const ids = siblings.map((a: { id: string }) => a.id);

      /* EVERY SIBLING IS TESTED BEFORE ANYTHING IS WRITTEN, which is the
         other half of R5's rule and the half that is easy to drop. The RPC
         tests permission and eligibility for the whole tenancy and aborts
         the lot on a single refusal. This path tested `withdrawn_at` on the
         clicked application alone, so without the same pre-check a
         correction would move a withdrawn sibling's date and tear down a
         deed that should never have been touched. */
      const withdrawn = siblings.filter((a: { withdrawn_at: string | null }) => a.withdrawn_at);
      if (withdrawn.length) {
        const mine = withdrawn.some((a: { id: string }) => a.id === full.id);
        return json({
          ok: false,
          error: mine
            ? "This guarantee has been withdrawn, so its date cannot be changed here. Reply to the deed email if you need help."
            : "The other tenant on this tenancy has been withdrawn, so the date cannot be changed here. Reply to the deed email and we will sort it out.",
        }, 200);
      }

      const dateChange = `from ${dmy(full.tenancy_start)} to ${dmy(proposed)}`;

      /* 1) CLAIM THE TOKEN FIRST, and claim it conditionally.

         submitted_at was written at step 2, AFTER the date change and the deed
         lifecycle below, and nothing ever refused a token that already had it.
         The "load" action reported alreadySubmitted and the screen hid the
         form; the POST behind it did not care. So the link -- which needs no
         sign-in, because the token IS the authorisation, and which sits in an
         agent's inbox for seven days -- could be replayed. Each replay moved
         the tenancy start again and, for an executed guarantee, archived the
         signed PDF and reissued the deed for signing. A forwarded email or a
         double-click on a slow connection was enough.

         Claiming first also closes the race that ordering alone would not: the
         `.is("submitted_at", null)` filter makes the claim the atomic step, so
         of two simultaneous submits exactly one proceeds. */
      /* CLAIMED BY APPLICATION, NOT BY TOKEN. Round 6, M4. Scoping the claim
         to the presented token left every OTHER outstanding link for the same
         application live, and one is minted on every deed send. The correction
         is a property of the APPLICATION -- there is one tenancy start and it
         is either corrected or not -- so claiming burns every unsubmitted
         token for it in one statement. Still atomic, and still exactly one
         winner between two simultaneous submits, because `.is("submitted_at",
         null)` is what makes the update the claim. Also cleans up the
         accumulation that already exists from before deedEmail started
         reusing. */
      const nowIso = new Date().toISOString();
      const { data: claimedRows } = await service.from("tenancy_correction_tokens")
        .update({ proposed_start: proposed, note, submitted_at: nowIso, resolved_at: nowIso, resolved_by: null })
        .in("application_id", ids)
        .is("submitted_at", null)
        .select("token");
      // The presented token must be one of the ones just claimed. If it is not,
      // it had already been used, and somebody else's live token being burned
      // alongside would not make this submit legitimate.
      const claimed = (claimedRows ?? []).some((r: { token: string }) => r.token === token);
      if (!claimed) {
        return json({
          ok: false, alreadySubmitted: true,
          error: "This correction has already been submitted. If the date still looks wrong, reply to the deed email and we will sort it out.",
        }, 200);
      }

      // 2) Apply the corrected date to EVERY application in the tenancy
      //    (expiry_date is a generated column and follows), and to the
      //    tenancy row itself, which is what R5 added it for. Leaving the
      //    tenancy behind means the applications agree with each other and
      //    disagree with the let they belong to.
      await service.from("applications").update({ tenancy_start: proposed }).in("id", ids);
      if (full.tenancy_id) {
        await service.from("tenancies").update({ tenancy_start: proposed }).eq("id", full.tenancy_id);
      }

      // 3) Deed lifecycle, keyed on the state at correction time. Mirrors
      //    amend-tenancy-start (its executed / awaiting_tenant branches); the
      //    dangerous primitives (void, regenerate + state reset) are shared in
      //    pandadoc.ts, so only the branch choice lives in both places.
      /* Q1. THE LIFECYCLE RUNS FOR EVERY SIBLING, and this is the half
         that is easiest to leave behind: move the DATE for everybody and
         reissue the DEED for one, and you have the same divergence in a
         different column -- three applications agreeing on the start date,
         one corrected deed and two still stating the old one.

         Sequential, not Promise.all. Each iteration voids or archives a
         real document at PandaDoc and regenerates it, and the
         one-live-deed invariant below depends on the clear-then-void
         order holding per application. Two tenants is the realistic
         maximum, so nothing is gained by racing them and a partial
         failure is easier to read in order. */
      let reissued = false;
      let archived = false;
      const reissuedRefs: string[] = [];
      const failedRefs: string[] = [];

      for (const app of siblings) {
        let appReissued = false;
        let appArchived = false;
        if (app.deed_state === "executed" || app.status === "deed") {
          // Destructive: archive the signed PDF, reopen to Paid, reissue for signing.
          appArchived = !!app.executed_pdf_path;
          if (appArchived) {
            const archivePath = `${app.id}/archive/${app.guarantee_ref}-superseded-${app.pandadoc_document_id ?? "deed"}.pdf`;
            await service.storage.from("deeds").copy(app.executed_pdf_path, archivePath);
            await service.from("activity_log").insert({ application_id: app.id, kind: "deed_archived", message: `Signed deed archived before an agent correction of the tenancy start ${dateChange}.`, actor: "Agent", visibility: "business" });
          }
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
            deed_delivery_superseded_at: app.deed_delivered_at ?? app.deed_delivery_superseded_at ?? null,
            deed_delivery_superseded_to: app.deed_delivered_to ?? app.deed_delivery_superseded_to ?? null,
            deed_delivered_at: null, deed_delivered_to: null, deed_resent_at: null,
          }).eq("id", app.id);
          const gen = await generateDeed(service, app.id, true);
          appReissued = gen.ok;
          // OPNDOOR SENDS IT. Matt (ai): PandaDoc is silent, so a corrected
          // deed nobody emails about is a corrected deed nobody signs.
          if (gen.ok) await deliverSigningInvite(service, app.id, { reissue: true, by: "Agent" });
        } else if (app.deed_state === "awaiting_tenant" && app.pandadoc_document_id) {
          // One-live-deed invariant: clear the id first (a late webhook for the old
          // document is then inert), void best-effort, regenerate regardless.
          const oldDocId = app.pandadoc_document_id;
          await service.from("applications").update({ pandadoc_document_id: null, deed_state: null, deed_viewed_at: null }).eq("id", app.id);
          const voided = await voidDocument(oldDocId, app.livemode === true);
          await service.from("activity_log").insert({ application_id: app.id, kind: "deed_voided", message: voided.ok ? `Outstanding deed voided for an agent correction of the tenancy start ${dateChange}.` : `Outstanding deed could not be voided for an agent correction ${dateChange}; it is superseded by the reissued deed. Detail: ${voided.error}`, actor: "Agent", visibility: "internal" });
          const gen = await generateDeed(service, app.id, true);
          appReissued = gen.ok;
          if (gen.ok) await deliverSigningInvite(service, app.id, { reissue: true, by: "Agent" });
        } else {
          // Sent, or Paid with no live deed (error / declined / voided / none):
          // the date change alone, no reissue.
          continue;
        }
        archived = archived || appArchived;
        if (appReissued) { reissued = true; reissuedRefs.push(app.guarantee_ref); }
        else failedRefs.push(app.guarantee_ref);
      }

      /* 4) Log it, ON EVERY APPLICATION IN THE TENANCY. One entry on the
            clicked application would leave the co-tenant's own record
            silent about a change to their start date and their deed --
            and the co-tenant's record is the one their agent reads. Each
            entry names the whole tenancy so neither reader has to work
            out why their deed was reissued by somebody else's link. */
      const joint = siblings.length > 1;
      const suffix = failedRefs.length
        ? ` The corrected deed could not be reissued automatically for ${failedRefs.join(", ")}; opndoor has been notified.`
        : reissued
          ? (archived
              ? ` The signed deed was archived and a corrected deed reissued to the tenant to sign${joint ? ` for ${reissuedRefs.join(" and ")}` : ""}.`
              : ` A corrected deed was reissued to the tenant to sign${joint ? ` for ${reissuedRefs.join(" and ")}` : ""}.`)
          : "";
      const scope = joint ? ` This tenancy has ${siblings.length} tenants and all of them were corrected together.` : "";
      for (const app of siblings) {
        await service.from("activity_log").insert({
          application_id: app.id,
          kind: "tenancy_correction_applied",
          message: `${app.guarantee_ref}: tenancy start corrected ${dateChange} by the agent.${suffix}${scope}${note ? ` Note: ${note}` : ""}`,
          actor: "Agent",
          visibility: "business",
        });
      }
      /* THE NAMES, not just how many. The page has to say "Each tenant has
         been sent a corrected deed to sign: <names>", and it cannot name
         anybody it was not told about. */
      const tenantNames = (siblings as Array<{ tenant_first_name?: string; tenant_last_name?: string }>)
        .map((x) => `${x.tenant_first_name ?? ""} ${x.tenant_last_name ?? ""}`.trim())
        .filter(Boolean);
      return json({ ok: true, newStart: dmy(proposed), reissued, tenants: siblings.length, tenantNames });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (e) {
    return json({ ok: false, error: "Could not submit the tenancy correction." }, 500);
  }
});
