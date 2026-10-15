/* DEEDS NOT GENERATING, AND WHY NOBODY KNEW.

   Reported as a recurring fault on the live portal. Reading the chain end to end
   (stripe-webhook -> _shared/pandadoc.ts -> pandadoc-webhook) the striking thing
   is not that it can fail. Every integration can. It is that it could fail in
   eight distinct places and every one of them ended in an INTERNAL activity row
   on a single application and nothing else: no ops incident, no queue, nothing
   a person would ever be shown unless they already suspected that one deed and
   went looking for it. "Deeds are not generating" was therefore a thing agents
   told us, days later, one at a time, and the portal's own answer was silence.

   Four of those eight were worse than quiet, they were WRONG:

     - a failed deed_target RPC read as "solo tenancy, already paid", so a joint
       tenancy silently generated a single-tenant deed naming no co-tenants and
       guaranteeing no share;
     - a failed claim_tenancy_deed read as "somebody else has it", so a paid
       application got no deed and no record that one was attempted;
     - a pandadoc_events insert that was not a duplicate read as a duplicate, so
       a signed deed was answered 200 and never redelivered;
     - a deed email the provider refused read as delivered, because nothing in
       the tree ever called record_delivery_attempt and delivery_failed_at is
       what the "Delivery failed" badge reads.

   IT READS THE SOURCE, for the reason payLinkIsDurable.test.ts gives: these are
   Deno edge functions, Deno is not installed here, and they cannot be imported
   into vitest because they reach Deno.env at module scope. What can be checked
   without a runtime is the property that actually matters, which is structural:
   no result that decides whether a deed exists is discarded, and no path that
   ends without a deed ends without telling somebody. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const PANDADOC = 'supabase/functions/_shared/pandadoc.ts';
const STRIPE_HOOK = 'supabase/functions/stripe-webhook/index.ts';
const DEED_HOOK = 'supabase/functions/pandadoc-webhook/index.ts';
/* THE COMPLETION SEQUENCE MOVED, 2026-10-15, and these assertions followed it.
   deed-sweep now reconciles a deed that was signed in PandaDoc and whose
   callback was lost (GR-20611 and GR-20612 on 14 October), and it has to reach
   the same end state as the webhook. So the webhook's completion body is now
   _shared/deedCompletion.ts and both call it. Nothing below changed its
   meaning: the download, the store, the execution and the delivery are the
   same code in a different file, which the diff of the move shows and which
   aSignedDeedIsFoundWithoutItsCallback.test.ts pins from the other side. */
const DEED_DONE = 'supabase/functions/_shared/deedCompletion.ts';
const MANUAL_SEND = 'supabase/functions/send-deed-to-agent/index.ts';

/** The body of generateDeed, which is where every generation decision is made. */
function generateDeedBody(): string {
  const src = read(PANDADOC);
  const start = src.indexOf('export async function generateDeed');
  expect(start, 'generateDeed has been renamed and every assertion below is passing over nothing').toBeGreaterThan(-1);
  return src.slice(start);
}

describe('generateDeed does not mistake a broken read for an answer', () => {
  it('checks the deed_target error instead of discarding it', () => {
    /* THE ONE THAT PRODUCES A WRONG DOCUMENT RATHER THAN NO DOCUMENT.
       supabase-js returns the error rather than throwing, so `const { data: tgt }`
       left tgt undefined on a failure, and undefined answers every question
       below it the way a tenancy of one does: the paid gate is skipped, joint is
       false, and co_tenant_names / share_amount / tenancy_tenant_names all go
       null. On a joint tenancy that is a legally wrong deed, signed. */
    const body = generateDeedBody();
    expect(body).toMatch(/rpc\("deed_target"[\s\S]{0,40}?\)/);
    expect(body).toMatch(/const \{ data: tgt, error: tgtErr \} = await service\.rpc\("deed_target"/);
    expect(body).toMatch(/if \(tgtErr\)/);
  });

  it('checks the deed_delivery_target error too, so an unread ladder is not an empty one', () => {
    // The branch below this one is terminal (it sets deed_state error and stops
    // generating), so "the RPC failed" must not fall into "this agency has
    // nobody".
    const body = generateDeedBody();
    expect(body).toMatch(/const \{ data: target, error: targetErr \} = await service\.rpc\("deed_delivery_target"/);
    expect(body).toMatch(/if \(targetErr\)/);
  });

  it('parks a missing recipient in the queryable queue, not only in an activity row', () => {
    /* A missing recipient must park VISIBLY. awaiting_staff_send is the flag the
       needs-attention surface filters on and the only one deliveryStateOf reads
       for 'cannot_deliver'; this branch set deed_state error and wrote one
       internal activity line, so a paid tenant with no deed appeared in no queue
       anywhere. */
    const body = generateDeedBody();
    const noContact = body.slice(body.indexOf('if (!agentEmail)'));
    expect(noContact.indexOf('if (!agentEmail)')).toBe(0);
    const branch = noContact.slice(0, noContact.indexOf('return {'));
    expect(branch).toMatch(/awaiting_staff_send:\s*true/);
    expect(branch).toMatch(/report_ops_incident/);
  });

  it('leaves the queue again when a later generation works', () => {
    // Otherwise the row parked above never comes out of it, and staff are asked
    // for ever to act on something already fixed.
    const body = generateDeedBody();
    const stamp = body.slice(body.indexOf('deed_state: "awaiting_tenant"'));
    expect(stamp.slice(0, 400)).toMatch(/awaiting_staff_send:\s*false/);
  });

  it('checks that the application row was actually stamped with the document id', () => {
    /* The worst shape in the chain. The document exists at PandaDoc and the
       tenant has been emailed it, but the row does not carry its id, so
       apply_deed_executed (which matches on pandadoc_document_id and returns
       silently when it finds nothing) will do nothing for ever when they sign. */
    const body = generateDeedBody();
    expect(body).toMatch(/const \{ error: stampErr \} = await service\s*\n?\s*\.?from\("applications"\)|const \{ error: stampErr \} = await service\.from\("applications"\)/);
    expect(body).toMatch(/if \(stampErr\)/);
    expect(body).toMatch(/deed_document_unattached/);
  });

  it('raises an ops incident on every path that ends without a deed', () => {
    /* The whole point. On production the commonest cause of this fault is not
       per-application at all: one unset PANDADOC_API_KEY or PANDADOC_TEMPLATE_ID
       fails EVERY generation identically, and used to do it one silent internal
       row at a time. report_ops_incident is deduped hourly, so the blast radius
       of saying so is one alert an hour. */
    const body = generateDeedBody();
    const incidents = body.match(/report_ops_incident/g)?.length ?? 0;
    // failGeneration covers the shared paths; the no-contact park and the
    // unattached-document orphan each raise their own named type.
    expect(incidents).toBeGreaterThanOrEqual(2);
    /* The failGeneration BODY, not a character budget from its name. The original
       assertion allowed 700 characters and broke the moment the function grew a
       comment, which is a test failing for a reason that has nothing to do with
       what it is protecting. Matched to the closing brace instead, so it asserts
       the property (this function raises an incident) rather than the layout. */
    const fg = read(PANDADOC).match(/async function failGeneration[\s\S]*?\n\}/);
    expect(fg).not.toBeNull();
    expect(fg![0]).toContain('report_ops_incident');
    /* And it records the attempt through record_deed_failure, which owns the
       state, the reason and the consecutive count together. Writing deed_state
       directly here would let the three drift apart across the call sites, and the
       count is what parks a repeatedly failing application for staff
       (20261005260000). */
    expect(fg![0]).toContain('record_deed_failure');
  });
});

describe('stripe-webhook does not drop the deed on a failed claim', () => {
  it('distinguishes a claim refusal from a claim error', () => {
    /* `.then(r => r.data === true)` read false for both "already claimed"
       (correct, do nothing) and "the RPC failed" (a paid application that gets
       no deed). The second was invisible: the one line that could report the
       commonest silent cause was the line that could not. */
    const src = read(STRIPE_HOOK);
    expect(src).not.toMatch(/rpc\("claim_tenancy_deed"[^)]*\}\)\.then\(/);
    expect(src).toMatch(/const claim = await service\.rpc\("claim_tenancy_deed"/);
    expect(src).toMatch(/if \(claim\.error\)/);
    expect(src).toMatch(/else if \(claim\.data === true\)/);
    expect(src).toMatch(/deed_claim_failed/);
  });

  it('still generates exactly once when the claim succeeds', () => {
    // Removing the wrong behaviour must not remove the right one: the claim is
    // what stops two deliveries of one payment minting two documents.
    const src = read(STRIPE_HOOK);
    expect(src.match(/generateDeed\(service, appId\)/g)?.length ?? 0).toBe(1);
    expect(src).toMatch(/release_tenancy_deed_claim/);
  });
});

describe('pandadoc-webhook notices when a deed does not come back', () => {
  it('only a duplicate skips the dedup insert', () => {
    /* Every insert failure was read as a duplicate: the event was skipped, the
       handler still answered 200, and PandaDoc marked delivery successful and
       never sent it again. A signed deed lost permanently on a blip. This is the
       same defect stripe-webhook already fixed on its own dedup line. */
    const src = read(DEED_HOOK);
    expect(src).not.toMatch(/if \(insErr\) continue;/);
    expect(src).toMatch(/if \(insErr\.code === "23505"\) continue;/);
  });

  it('says so when a callback fails its signature', () => {
    /* The quietest way a deed can die. An unset or rotated
       PANDADOC_WEBHOOK_SHARED_KEY 401s every completion in the estate, every
       deed stays at awaiting_tenant for ever, and the record of that was a
       status code handed back to PandaDoc and thrown away. */
    const src = read(DEED_HOOK);
    const rejection = src.slice(src.indexOf('if (!verified.ok)'), src.indexOf('const eventLivemode'));
    expect(rejection).toMatch(/report_ops_incident/);
    expect(rejection).toMatch(/PANDADOC_WEBHOOK_SHARED_KEY/);
    expect(rejection).toMatch(/status: 401/);
  });

  it('says so when a completion matches no application, and does not fetch its PDF', () => {
    /* apply_deed_executed is a silent no-op for an unknown document, which is
       deliberate (it is what makes a superseded document inert) and is exactly
       why this vanished. On dev, 27 of the 28 completions ever received match no
       application. Either they are superseded documents or this project's shared
       key is verifying another environment's callbacks, and the second means
       that environment's deeds are never executed. The download used to run
       before the check and have its result thrown away, which pulled someone
       else's executed deed into the function for nothing. */
    const src = read(DEED_HOOK);
    const guard = src.indexOf('status === "document.completed" && !app');
    expect(guard, 'the unknown-document guard has gone').toBeGreaterThan(-1);
    /* THE ORDERING IS THE WHOLE ASSERTION, and the move makes it stronger
       rather than weaker. The download now happens inside the shared
       completion sequence, so the only way to reach it is through the call
       below -- and the guard sits in front of that call. The webhook itself
       can no longer fetch anything, which is the property this was written
       for: someone else's executed deed is never pulled into this function. */
    const call = src.indexOf('completeSignedDeed(service, app, docId');
    expect(call).toBeGreaterThan(guard);
    expect(src.slice(guard, call)).toMatch(/pandadoc_completed_unknown_document/);
    expect(src).not.toMatch(/downloadPdf\(/);
  });

  it('writes down whether the automatic delivery actually worked', () => {
    /* record_delivery_attempt and the four columns behind it were added to
       separate "attempted and errored" from "nobody to send to", and then
       nothing ever called it: zero rows on dev carry delivery_attempted_to, so
       deliveryStateOf could return 'cannot_deliver' and 'delivered' but never
       'failed'. A refused agent email looked exactly like a delivered one. */
    const src = read(DEED_DONE);
    expect(src).toMatch(/const sent = await deliverDeedToAgent\(/);
    expect(src).toMatch(/record_delivery_attempt[\s\S]{0,300}p_ok: sent\.ok/);
  });

  it('does not stamp a delivery failure when there was nobody to deliver to', () => {
    /* The distinction is the whole of 20261005100000, and the tempting fix is
       the one it refuses: stamping delivery_failed_at on a queued deed puts a
       Resend button in front of an agency for a send never attempted. The
       cannot-deliver branch queues and stays admin-facing. */
    const src = read(DEED_DONE);
    const elseBranch = src.slice(src.indexOf('const heldForPeople'), src.indexOf('Resend allows 2 req/sec'));
    expect(elseBranch).not.toMatch(/record_delivery_attempt/);
    expect(elseBranch).toMatch(/awaiting_staff_send: true/);
    expect(elseBranch).toMatch(/visibility: "internal"/);
  });

  it('turns a thrown handler into a 500 with an incident, not a bare rejection', () => {
    // Two paths throw on purpose so PandaDoc retries. Without a catch they
    // escaped unrecorded, and nobody learned that a deed spent the afternoon
    // failing to execute.
    const src = read(DEED_HOOK);
    const catchAt = src.indexOf('} catch (e) {');
    expect(catchAt, 'the batch guard has gone').toBeGreaterThan(-1);
    const handler = src.slice(catchAt);
    expect(handler).toMatch(/report_ops_incident/);
    expect(handler).toMatch(/status: 500/);
  });
});

describe('the manual send records its outcome too', () => {
  it('send-deed-to-agent writes down both outcomes', () => {
    // It is the recovery path for everything above, so a recovery that failed
    // has to be visible as a failure rather than only as a return value read by
    // whoever happened to press the button.
    const src = read(MANUAL_SEND);
    expect(src).toMatch(/record_delivery_attempt[\s\S]{0,300}p_ok: out\.ok/);
    // record_delivery_attempt clears the queue itself on success, so the old
    // hand-rolled update must be gone rather than racing it.
    expect(src).not.toMatch(/awaiting_staff_send: false/);
  });

  it('and still parks an unresolvable contact without calling it a failure', () => {
    const src = read(MANUAL_SEND);
    const noContact = src.slice(src.indexOf('if (!sentTo)'), src.indexOf('Greet by the resolved'));
    expect(noContact).toMatch(/awaiting_staff_send: true/);
    expect(noContact).not.toMatch(/record_delivery_attempt/);
    expect(noContact).toMatch(/visibility: "internal"/);
  });
});

/* ===========================================================================
   THE REVIEW FINDINGS, read back over the fixes above as if by a stranger.
   Reviewing the deed chain after it had been repaired turned up nine more, and
   they are a different shape from the eight: not "it fails quietly" but "it
   succeeds wrongly". Each one below produces a state the portal reports as
   healthy and is not.
   =========================================================================== */

describe('two presses of Generate make one deed', () => {
  it('takes a lease before it does anything, and releases it in a finally', () => {
    /* THE HOLE THE DOCUMENT CHECK CANNOT COVER. The exists check refuses a
       second press that arrives AFTER the first has stamped its id. Two presses
       inside the generation window both read "no document" before either has
       created one, and PandaDoc creation takes seconds, so a double-click made
       two live signable Deeds of Guarantee, the second stamped over the first
       and the first left live with nothing in the portal pointing at it.

       The lease wraps generateDeed rather than sitting at the call sites: there
       are seven of them, and a guard each one has to remember is a guard the
       eighth will not have. */
    const src = read(PANDADOC);
    const wrapper = src.slice(src.indexOf('export async function generateDeed'), src.indexOf('async function runGeneration'));
    expect(wrapper, 'the lease wrapper has gone').toMatch(/take_deed_lease/);
    // Refused means stop. Carrying on would defeat the entire guard.
    expect(wrapper).toMatch(/if \(leased !== true\)/);
    /* A finally, so every failure path hands it back. A failure is retried
       (20261005260000) and a lease held by a failed run makes the retry wait out
       the stale window for nothing. */
    expect(wrapper).toMatch(/finally \{[\s\S]*?release_deed_lease/);
  });

  it('covers every call site, because the guard is inside the shared function', () => {
    // If a caller could reach the generation body without the wrapper, the mutex
    // would be advisory. runGeneration is module-private and called once.
    const src = read(PANDADOC);
    expect(src).not.toMatch(/export async function runGeneration/);
    expect(src.match(/runGeneration\(/g)?.length ?? 0).toBe(2); // the declaration and its one call
  });

  it('does not count a lost race as a failed attempt', () => {
    /* record_deed_failure increments the consecutive count and parks the
       application at three. A double-press is not a fault, so three fast
       double-presses must not park a perfectly healthy application. */
    const src = read(PANDADOC);
    const refusal = src.slice(src.indexOf('if (leased !== true)'), src.indexOf('try {'));
    expect(refusal).not.toMatch(/failGeneration|record_deed_failure/);
  });
});

describe('an alert that has never been written is worse than none', () => {
  it('raises ops alerts through the RPC, never by inserting into the table', () => {
    /* ops_alerts.hour_bucket is NOT NULL with no default, so every direct insert
       in the tree failed on every call, and each one was written
       `.then(() => {}, () => {})`, which swallowed the error. Three alerts had
       therefore never been raised once in their lives: stripe_livemode_mismatch,
       pandadoc_livemode_mismatch and hubspot_map_drift. Proved by running the
       insert as it stood against dev: zero rows.

       The RPC is the only correct way in regardless. It fills hour_bucket, dedups
       to one row per type per hour so a platform-wide cause raises one alert
       rather than one per payment, and dispatches the ops-alert email. A direct
       insert skips all three even when it works. */
    for (const f of ['supabase/functions/stripe-webhook/index.ts',
                     'supabase/functions/pandadoc-webhook/index.ts',
                     'supabase/functions/hubspot-sync/index.ts']) {
      expect(read(f), `${f} inserts into ops_alerts directly, which silently writes nothing`)
        .not.toMatch(/from\("ops_alerts"\)\s*\.insert/);
    }
  });

  it('still raises all three, by name', () => {
    // Removing the broken call must not remove the alert.
    expect(read(STRIPE_HOOK)).toMatch(/report_ops_incident[\s\S]{0,200}stripe_livemode_mismatch/);
    expect(read(DEED_HOOK)).toMatch(/report_ops_incident[\s\S]{0,400}pandadoc_livemode_mismatch/);
    expect(read('supabase/functions/hubspot-sync/index.ts')).toMatch(/report_ops_incident[\s\S]{0,600}hubspot_map_drift/);
  });
});

describe('a read that failed is not an answer', () => {
  it('does not let the one-document guard fail open', () => {
    /* The exists check discarded its error, and supabase-js returns the error
       rather than throwing, so a transient read failure left `existing`
       undefined and the optional chain falsy: the guard read "no document
       exists" and generation carried on. The one time this read fails is the
       time it matters most, because whatever is wrong with the database is as
       likely to have the other press in flight. */
    const body = generateDeedBody();
    expect(body).toMatch(/const \{ data: existing, error: existingErr \}/);
    expect(body).toMatch(/if \(existingErr\)/);
  });

  it('does not report an unreadable application as a missing one', () => {
    // `if (!app) return "Application not found."` was reached by a failed read
    // too, so the Generate button told the user the application they were
    // looking at does not exist, and recorded nothing at all.
    const body = generateDeedBody();
    expect(body).toMatch(/const \{ data: app, error: appErr \}/);
    const appCheck = body.slice(body.indexOf('const { data: app, error: appErr }'));
    expect(appCheck.indexOf('if (appErr)')).toBeGreaterThan(-1);
    expect(appCheck.indexOf('if (appErr)')).toBeLessThan(appCheck.indexOf('if (!app)'));
  });

  it('does not report a lost signed deed as somebody else\'s document', () => {
    /* The webhook's application lookup discarded its error, and undefined is
       exactly what an unknown document looks like. A completion whose lookup
       blipped fell into the unknown-document branch, raised an alert blaming a
       superseded document or a misconfigured key, wrote its dedup row and
       answered 200. The deed is signed, the application never learns, and
       PandaDoc will not send it again. It is retryable, so it is retried. */
    const src = read(DEED_HOOK);
    expect(src).toMatch(/const \{ data: app, error: appErr \}/);
    const check = src.slice(src.indexOf('const { data: app, error: appErr }'));
    const guard = check.indexOf('if (appErr)');
    expect(guard).toBeGreaterThan(-1);
    // Before the unknown-document branch, or it would never be reached.
    expect(guard).toBeLessThan(check.indexOf('status === "document.completed" && !app'));
    // Dropping the dedup row is what makes the redelivery reprocess rather than
    // being deduped into a 200.
    expect(check.slice(guard, guard + 500)).toMatch(/pandadoc_events"\)\s*\.delete\(\)/);
    expect(check.slice(guard, guard + 500)).toMatch(/throw new Error/);
  });
});

describe('the signed deed is secured before anything is called done', () => {
  it('gives downloadPdf a reason, so its caller can tell a race from a bad key', () => {
    /* Every failure collapsed to null: an unset key, a 401, a network blip and
       "PandaDoc has not finished rendering the PDF" were one value. The last is
       not an edge case, because PandaDoc renders the signed PDF AFTER it fires
       document.completed, so an immediate fetch legitimately 404s for a few
       seconds. That is the commonest way a deed ends up executed with no
       document. */
    const src = read(PANDADOC);
    expect(src).toMatch(/export async function downloadPdf\([\s\S]{0,120}Promise<PdfResult>/);
    expect(src).toMatch(/export interface PdfResult/);
  });

  it('retries instead of executing the deed without its document', () => {
    /* The download result was ignored and the deed executed with p_pdf_path
       null, with the dedup row already committed, so the signed document was
       gone for good. Four surfaces then have nothing to show and no repair path:
       send-deed-to-agent and send-deed-to-landlord mail a link to nothing,
       tenant-portal answers "not ready to download yet" for ever, and
       referencing-callback counts the application as failed. */
    const src = read(DEED_DONE);
    const from = src.indexOf('const pdf = await downloadPdf(docId');
    expect(from, 'the download has moved').toBeGreaterThan(-1);
    // Searched FROM the download: the name appears in this file's own header
    // comment long before the call, and anchoring on that measured nothing.
    const to = src.indexOf('rpc("apply_deed_executed"', from);
    expect(to).toBeGreaterThan(from);
    const between = src.slice(from, to);
    // The deed is not executed until the PDF is in hand and stored.
    expect(between).toMatch(/if \(!pdf\.ok \|\| !pdf\.bytes\)/);
    expect(between).toMatch(/deed_pdf_unavailable/);
    // The upload error was discarded too, which wrote a path pointing at an
    // object that was never stored.
    expect(between).toMatch(/const \{ error: upErr \}/);
    expect(between).toMatch(/deed_pdf_not_stored/);
    /* BOTH STILL RETRY, said the way the shared sequence says it: drop the
       dedup row and hand back a retryable failure. The webhook turns that into
       a throw and a 500 so PandaDoc redelivers; the sweep leaves the row alone
       and the next hour is its redelivery. The two callers differ only there,
       which is the one thing the move changed. */
    expect(between.match(/retryable: true/g)?.length ?? 0).toBe(2);
    expect(between.match(/pandadoc_events"\)\.delete\(\)/g)?.length ?? 0).toBe(2);
  });
});

describe('sandbox does not fake a needs-attention queue', () => {
  it('asks whether the deed is deliverable separately from whether we may email', () => {
    /* "Can this deed be delivered" is a question about the APPLICATION. "May we
       send email" is a question about the ENVIRONMENT. Tested together, sandbox
       lied: a perfectly deliverable deed fell into the cannot-deliver branch,
       parked as awaiting_staff_send, wrote "No agent contact on file" into the
       feed and raised a deed_awaiting_staff_send incident. None of it true, and
       it is the queue Balal reads at cutover to judge whether the chain works. */
    const src = read(DEED_DONE);
    expect(src).toMatch(/const deliverable = !targetErr && !!dest\?\.email/);
    expect(src).toMatch(/if \(targetErr\)/);
    expect(src).toMatch(/\} else if \(deliverable && mayEmail\) \{/);
    // The sandbox case is its own branch: nothing sent, nothing parked.
    expect(src).toMatch(/\} else if \(deliverable\) \{/);
    const sandbox = src.slice(src.indexOf('} else if (deliverable) {'), src.indexOf('// CANNOT DELIVER'));
    expect(sandbox).not.toMatch(/awaiting_staff_send/);
    expect(sandbox).toMatch(/deed_delivery_suppressed/);
  });

  it('parks an unreadable delivery target honestly rather than as "no contact"', () => {
    // Same class as the reads above: an unread ladder is not an empty one. It
    // cannot be retried here (the deed is executed and the dedup row committed),
    // so it parks with a true reason that the manual send clears.
    const src = read(DEED_DONE);
    const branch = src.slice(src.indexOf('if (targetErr) {'), src.indexOf('} else if (deliverable && mayEmail)'));
    expect(branch).toMatch(/deed_delivery_target_unreadable/);
    expect(branch).toMatch(/awaiting_staff_send: true/);
    expect(branch).not.toMatch(/No agent contact on file/);
  });
});

describe('a document we created is never left behind', () => {
  it('voids the orphan when createAndSend fails after creating it', () => {
    /* createAndSend does two calls, create then send, and a failure at the send
       step returns ok:false WITH a documentId. That id was thrown away, so the
       row kept nothing, the next retry created a second document and the first
       stayed in PandaDoc for ever: one orphan per attempt over a bad afternoon.
       Voiding also settles the ambiguous case, a send whose RESPONSE failed
       after PandaDoc had processed it, where the tenant has a signable deed we
       hold no id for. */
    const body = generateDeedBody();
    const branch = body.slice(body.indexOf('if (!res.ok) {'), body.indexOf('if (!res.documentId)'));
    expect(branch).toMatch(/if \(res\.documentId\)/);
    expect(branch).toMatch(/voidDocument\(res\.documentId/);
    expect(branch).toMatch(/deed_orphan_document/);
  });

  it('secures the id alone when the full stamp is refused', () => {
    /* The old code stopped at an incident asking a person to attach an id by
       hand: a dead end dressed as an alert. Nothing retried it, the tenant signed
       into a void the whole time, and the next pass made a SECOND document
       because the row still looked ungenerated.

       The failed write set eight columns; the realistic causes are properties of
       one of the other seven. The id is the only one that matters for
       correctness, because apply_deed_executed matches on it, so with the id
       written the signature lands and the one-document guard holds. */
    const body = generateDeedBody();
    const branch = body.slice(body.indexOf('if (stampErr) {'));
    expect(branch).toMatch(/const \{ error: minimalErr \}[\s\S]{0,200}update\(\{ pandadoc_document_id: res\.documentId \}\)/);
    expect(branch).toMatch(/deed_stamp_partial/);
    /* And if even that is refused the row can never match this document, so the
       document is voided rather than left live for a tenant to sign into
       nothing. Leaving it would also let the next pass add a second deed beside
       it, which is the failure the lease exists to prevent. */
    const worst = branch.slice(branch.indexOf('if (!minimalErr)'));
    expect(worst).toMatch(/voidDocument\(res\.documentId/);
    expect(worst).toMatch(/deed_document_unattached/);
  });
});

describe('the deed renders from one template, joint or solo', () => {
  it('prints six merge tokens and never a share', () => {
    /* RULING (27 Sep): the template does not change. Each tenant signs their own
       deed, for their own share, naming all the tenants, and the SHARE is
       recorded on the application and the bordereau, not in the document.

       guaranteed_amount and co_tenant_names briefly existed to print the share
       and the co-tenants. They needed a template change to render at all, and an
       unrendered token is not a neutral extra: it is an amount the deed appears
       to state and does not. */
    const src = read(PANDADOC);
    const fn = src.match(/function tokens\(a: DeedApp[\s\S]*?\n\}/);
    expect(fn, 'the token builder has been renamed').not.toBeNull();
    const body = fn![0];
    expect(body).not.toMatch(/guaranteed_amount/);
    expect(body).not.toMatch(/co_tenant_names/);
    expect(body.match(/\{ name: "/g)?.length ?? 0).toBe(6);
    // No conditional list any more: the same six on every deed.
    expect(body).not.toMatch(/return base/);
  });

  it('still names every tenant, which is the part the document does carry', () => {
    // The deed says which tenancy it is part of. On a solo application the list
    // is the applicant alone, so that document is unchanged.
    const src = read(PANDADOC);
    expect(src).toMatch(/\{ name: "tenant_name", value: a\.tenancy_tenant_names \|\|/);
    expect(generateDeedBody()).toMatch(/tenancy_tenant_names: joint \?/);
  });

  it('does not pass a share to the document at all', () => {
    // Not merely unused: absent, so nothing suggests the deed carries a figure.
    const src = read(PANDADOC);
    expect(src).not.toMatch(/share_amount/);
  });
});
