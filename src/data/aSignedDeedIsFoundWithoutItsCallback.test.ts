/* A SIGNED DEED IS FOUND WITHOUT ITS CALLBACK.
 *
 * Matt, 2026-10-15: "Two Regent deeds, GR-20612 (PandaDoc document
 * iREA49QqsKvRyjUNwVFrYb) and GR-20611, show COMPLETED in PandaDoc since the
 * evening of 14 Oct, but live never recorded it... The hourly deed-sweep has
 * run every hour since and not picked them up."
 *
 * It could not have. deeds_awaiting_generation selects on
 * `pandadoc_document_id is null` AND `deed_state is null or 'error'`, and both
 * rows hold a document at 'awaiting_tenant', so they are excluded twice over.
 * The sweep answered "who was never sent a deed". Nobody ever answered "who
 * signed one we never heard about", so a lost callback was permanent and
 * invisible: PandaDoc considers a delivered-once webhook done, and nothing in
 * the product watched for the absence.
 *
 * WHY THESE ARE SOURCE ASSERTIONS, in the pattern
 * aCorrectedDeedIsDeliveredToo.test.ts established. The changed files are Deno
 * edge functions and Deno is not installed here, so they are syntax-checked
 * with esbuild and cannot be executed by vitest.
 *
 * The parts that CAN be executed are, elsewhere, and this file deliberately
 * does not duplicate them:
 *
 *   - the selection rule, the state transition it produces, and the lock
 *     between the two paths: a_signed_deed_is_found_without_its_callback.test.sql
 *     (22 assertions against dev)
 *   - the PandaDoc status read and the classification: measured on dev with a
 *     cron-authed { dryRun: true } run, which read all five of dev's open
 *     documents and correctly reported every one still 'document.sent'
 *
 * What is left, and what this file pins, is the SHAPE: that there is exactly
 * one completion path in the product, that the sweep takes the lock before it
 * uses it, and that a failed status read is never mistaken for "not signed".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const WEBHOOK = read('supabase/functions/pandadoc-webhook/index.ts');
const SWEEP = read('supabase/functions/deed-sweep/index.ts');
const SHARED = read('supabase/functions/_shared/deedCompletion.ts');

/* THE WHOLE POINT OF THE SHAPE. A second implementation of "a deed was
   signed" would drift from the first, and the first is 280 lines of handling
   written against specific failures: a PDF PandaDoc has not rendered yet, an
   upload that fails, a refunded application, an agency with nobody active to
   receive the deed, a replayed completion that must not deliver twice. A
   sweep that re-implemented any of that would be a second set of those bugs. */
describe('there is one completion path, not two', () => {
  it('the webhook calls the shared sequence rather than carrying its own', () => {
    expect(WEBHOOK).toContain('import { completeSignedDeed, COMPLETION_APP_COLUMNS } from "../_shared/deedCompletion.ts";');
    expect(WEBHOOK).toContain('const done = await completeSignedDeed(service, app, docId, eventLivemode);');
  });

  it('and the sweep calls the same one', () => {
    expect(SWEEP).toContain('from "../_shared/deedCompletion.ts"');
    expect(SWEEP).toContain('await completeSignedDeed(service, app, d.pandadoc_document_id, d.livemode === true)');
  });

  /* THE EVIDENCE THAT THE MOVE WAS A MOVE. If the webhook still downloaded the
     PDF or sent either email, the sequence would exist twice over and this
     whole exercise would have added a path instead of sharing one. */
  it('so the webhook no longer downloads, stores, executes or delivers anything itself', () => {
    for (const gone of ['downloadPdf', 'deliverDeedToAgent', 'deliverExecutedDeedToTenant', 'apply_deed_executed', 'deed_delivery_target', 'record_delivery_attempt']) {
      expect(WEBHOOK, `${gone} should live only in the shared sequence now`).not.toContain(`${gone}(`);
    }
  });

  it('and the shared sequence is where all of that went', () => {
    for (const moved of ['downloadPdf(', 'deliverDeedToAgent(', 'deliverExecutedDeedToTenant(', 'apply_deed_executed', 'deed_delivery_target', 'record_delivery_attempt']) {
      expect(SHARED).toContain(moved);
    }
  });

  /* ONE COLUMN LIST. The sequence reads fifteen columns and a caller selecting
     fourteen produces a bug that shows only on the branch touching the
     missing one. Both callers take the list from the module that uses it. */
  it('and both callers select the same columns, from the module that reads them', () => {
    expect(SHARED).toContain('export const COMPLETION_APP_COLUMNS');
    expect(WEBHOOK).toContain('.select(COMPLETION_APP_COLUMNS)');
    expect(SWEEP).toContain('.select(COMPLETION_APP_COLUMNS)');
  });
});

/* WHAT STOPS ONE SIGNATURE BEING DELIVERED TWICE. The sweep runs hourly while
   the webhook is still live, so both can meet the same completion: a
   redelivery landing mid-sweep, or a callback arriving while the sweep is
   reconciling the same document. pandadoc_events is the mutual exclusion,
   which is why the lock is taken BEFORE the work and not after it. */
describe('the lock between the two paths', () => {
  it('is the same event id on both sides, built in one place', () => {
    expect(SHARED).toContain('export const completionEventId = (docId: string) => `${docId}:document.completed`;');
    expect(SWEEP).toContain('const evId = completionEventId(d.pandadoc_document_id);');
  });

  it('is taken before the completion sequence runs, not after it', () => {
    const lock = SWEEP.indexOf('.insert({ id: evId, type: "document.completed" })');
    const work = SWEEP.indexOf('await completeSignedDeed(service, app,');
    expect(lock).toBeGreaterThan(-1);
    expect(work).toBeGreaterThan(lock);
  });

  /* A DUPLICATE IS THE OTHER PATH HAVING IT, which is not a fault. Anything
     else is: reading every insert failure as a duplicate is the exact defect
     the webhook's own dedup line was fixed for, and it loses a signed deed on
     a blip. */
  it('and only a duplicate key means "not ours to do"', () => {
    expect(SWEEP).toContain('if (lockErr.code !== "23505")');
  });

  /* Or the webhook could never re-present it either: the lock would sit there
     for ever with nothing behind it, and a redelivery would be deduped into a
     200 against an application that was never executed. */
  it('and a lock taken over a row that then cannot be read is given back', () => {
    const i = SWEEP.indexOf('could not re-read the application');
    expect(i).toBeGreaterThan(-1);
    expect(SWEEP.slice(i - 400, i)).toContain('.delete().eq("id", evId)');
  });
});

/* THE FAILURE MODE THIS ARM COULD INTRODUCE, if it were written carelessly: a
   401 from a rotated key, a 429, or an unreachable API read as "not completed
   yet". That would be the original bug with extra steps -- a sweep that runs
   every hour, concludes nothing is wrong, and says so. */
describe('a failed status read is not an answer', () => {
  it('the helper refuses to invent a status', () => {
    expect(SHARED).not.toContain('status ?? "document');
    const src = read('supabase/functions/_shared/pandadoc.ts');
    expect(src).toContain('if (!status) return { ok: false, error: "PandaDoc returned no status for the document." };');
  });

  it('and an unreadable document leaves the row exactly as it was found', () => {
    const i = SWEEP.indexOf('unreadable.push({ ref: d.guarantee_ref, error: st.error });');
    expect(i).toBeGreaterThan(-1);
    // The arm ends there: nothing between it and the next candidate.
    expect(SWEEP.slice(i, i + 120)).toContain('continue;');
  });

  it('and only an actual completion is acted on', () => {
    expect(SWEEP).toContain('if (st.status !== "document.completed") {');
  });
});

/* THE PER-RUN BOUND HAS TO BE FAIR, or the fix only works until there are more
   open deeds than the cap. Ordered by age alone, a run of 25 would check the
   same 25 oldest open deeds every hour, and a deed signed this morning would
   sit behind a queue of deeds nobody is ever going to sign. */
describe('the sweep round-robins rather than starving a fresh deed', () => {
  it('stamps the check before asking, so a document it can never read goes to the back', () => {
    const stamp = SWEEP.indexOf('deed_status_checked_at: new Date().toISOString()');
    const ask = SWEEP.indexOf('await documentStatus(');
    expect(stamp).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(stamp);
  });

  it('and the candidate list is ordered by that stamp, never-asked first', () => {
    const mig = read('supabase/migrations/20261015000000_a_signed_deed_is_found_even_without_its_callback.sql');
    expect(mig).toContain('order by a.deed_status_checked_at asc nulls first');
  });
});

/* A REPAIRED LOSS IS STILL A LOSS. Once the sweep reconciles, nothing is
   broken for the agency any more, which is exactly why it has to be said out
   loud: a webhook that has silently stopped working would otherwise look like
   a healthy system with a slightly slow sweep. */
describe('and a reconciled completion is reported', () => {
  it('raises its own incident naming the document and what to check', () => {
    expect(SWEEP).toContain('p_type: "deed_completion_reconciled"');
    const i = SWEEP.indexOf('p_type: "deed_completion_reconciled"');
    const detail = SWEEP.slice(i, i + 900);
    expect(detail).toContain('PANDADOC_WEBHOOK_SHARED_KEY');
    expect(detail).toContain('webhook delivery history');
  });
});

/* THE MISTAKE THIS PINS, because I made it while testing this change.
 *
 * dryRun first gated the completion arm only. A cron-authed run made to ask
 * "what is stuck?" answered that safely and then did the generation arm's full
 * job on the way past: eleven PandaDoc documents created on dev and eleven
 * signing invites sent, every one of them redirected to EMAIL_REVIEW_ADDRESS.
 *
 * A flag called dryRun that acts is worse than no flag at all, because the
 * person using it has stopped watching. */
describe('a dry run is dry in both arms', () => {
  it('generates nothing, and does not even take the lease', () => {
    const guard = SWEEP.indexOf('if (dryRun) { wouldGenerate.push(c.guarantee_ref); continue; }');
    const claim = SWEEP.indexOf('claim_tenancy_deed');
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it('reconciles nothing, whoever is asking, cron included', () => {
    expect(SWEEP).toContain('const reconcile = dryRun ? false : (cronAuthed ? true : !!body.reconcile);');
  });

  it('and writes nothing, not even the checked-at stamp', () => {
    const i = SWEEP.indexOf('deed_status_checked_at: new Date().toISOString()');
    expect(SWEEP.slice(i - 200, i)).toContain('if (!dryRun) {');
  });

  /* And a MANUAL run defaults to it, because reconciling issues a legal
     document and emails an agency and a tenant. "What is stuck on production?"
     has to be a safe question to ask. */
  it('and a manual run has to ask twice before it acts', () => {
    expect(SWEEP).toContain('!!body.reconcile');
  });
});
