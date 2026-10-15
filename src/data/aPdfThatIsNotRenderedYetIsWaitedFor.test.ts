/* A SIGNED PDF THAT IS NOT RENDERED YET MUST NOT LOSE THE DEED.
 *
 * Read off live's deployed pandadoc-webhook v37 on 2026-10-15, downloaded into
 * ~/live-webhook-v37. Live was running a MIXED bundle:
 *
 *   index.ts            byte-identical to ours at 4a39fe6 (our handler)
 *   _shared/pandadoc.ts our file, except downloadPdf replaced by Balal's:
 *                         downloadPdf(documentId): Promise<Uint8Array | null>
 *                         12s retry on 409, Authorization: `API-Key ${KEY}`
 *
 * Our handler calls `downloadPdf(docId, eventLivemode)` and then reads
 * `pdf.ok`. Against that helper there is NO success path:
 *
 *   returns null          -> `pdf.ok` throws, BEFORE the branch that releases
 *                            the pandadoc_events row, so the claim is kept and
 *                            PandaDoc's retry is deduped into a 200: the deed
 *                            is lost for good
 *   returns a Uint8Array  -> `pdf.ok` is undefined, so `!pdf.ok` is true and it
 *                            takes the "PDF unavailable" branch anyway
 *
 * And `KEY` is declared nowhere in that file, so the fetch never even reaches
 * PandaDoc: it throws a ReferenceError inside the retry loop's own catch, spins
 * for twelve seconds and returns null. Every signature, deterministically.
 *
 * THE RETRY ITSELF WAS THE RIGHT IDEA. PandaDoc fires document.completed before
 * the signed PDF exists and answers 409 while it renders, which this codebase
 * already knew. So the fix keeps the waiting and drops the return type: still
 * PdfResult, still keyed per livemode through pandadocConfigFor.
 *
 * The policy lives in _shared/pandadocRetry.ts with no imports so that vitest
 * can execute it, the arrangement _shared/completionLock.ts established. The
 * loop around it and the claim-release are pinned as source assertions, because
 * these are Deno edge functions and cannot be run here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  downloadRetryVerdict,
  DOWNLOAD_RENDER_BUDGET_MS,
} from '../../supabase/functions/_shared/pandadocRetry.ts';

describe('while PandaDoc is still rendering', () => {
  it('waits a second and asks again', () => {
    expect(downloadRetryVerdict(409, 0)).toEqual({ wait: 1000 });
    expect(downloadRetryVerdict(409, 5_000)).toEqual({ wait: 1000 });
  });

  /* NEVER PAST THE BUDGET. A 409 at 11.9 seconds must not sleep a full second
     and ask again at 12.9: that is a request made after we had decided to stop,
     and a second of an edge function's wall clock spent after the answer was
     already known. */
  it('and never sleeps past the budget it has left', () => {
    expect(downloadRetryVerdict(409, 11_500)).toEqual({ wait: 500 });
    expect(downloadRetryVerdict(409, 11_999)).toEqual({ wait: 1 });
  });

  it('then gives up when the budget is gone', () => {
    expect(downloadRetryVerdict(409, DOWNLOAD_RENDER_BUDGET_MS)).toEqual({ giveUp: true });
    expect(downloadRetryVerdict(409, 99_000)).toEqual({ giveUp: true });
  });

  it('and the budget is twelve seconds, which is what live was already waiting', () => {
    expect(DOWNLOAD_RENDER_BUDGET_MS).toBe(12_000);
  });
});

describe('a thrown fetch', () => {
  /* A network blip deserves another go. Balal's version retried a throw too,
     and that is the one part of its error handling worth keeping. */
  it('is a blip and is retried', () => {
    expect(downloadRetryVerdict(null, 0)).toEqual({ wait: 1000 });
  });

  it('but is still bounded by the same budget', () => {
    expect(downloadRetryVerdict(null, 12_000)).toEqual({ giveUp: true });
  });
});

describe('anything else is an answer, not a delay', () => {
  /* A 401, 403 or 404 will not become a PDF by being asked again, and spending
     twelve seconds on one delays the honest failure the caller needs in order
     to release its claim and let PandaDoc redeliver. */
  it.each([400, 401, 403, 404, 410, 429, 500, 502, 503])('gives up at once on %i', (status) => {
    expect(downloadRetryVerdict(status, 0)).toEqual({ giveUp: true });
  });

  /* 429 IS DELIBERATELY IN THAT LIST and it is the one judgement call here.
     Waiting on a rate limit would be defensible, but the caller's retry is
     better placed to do it: it releases the claim, PandaDoc redelivers, and the
     sweep is behind that. Burning this budget inside one invocation would hold
     an edge function open and still leave the claim taken. */
  it('including a rate limit, which the caller retries rather than this loop', () => {
    expect(downloadRetryVerdict(429, 0)).toEqual({ giveUp: true });
  });

  it('and a custom budget is honoured, so a caller that knows better can say so', () => {
    expect(downloadRetryVerdict(409, 2_500, 3_000)).toEqual({ wait: 500 });
    expect(downloadRetryVerdict(409, 3_000, 3_000)).toEqual({ giveUp: true });
  });
});

const PD = readFileSync(join(process.cwd(), 'supabase/functions/_shared/pandadoc.ts'), 'utf8');
const DC = readFileSync(join(process.cwd(), 'supabase/functions/_shared/deedCompletion.ts'), 'utf8');

describe('the shape live got wrong', () => {
  it('downloadPdf takes livemode and returns PdfResult', () => {
    expect(PD).toContain('export async function downloadPdf(documentId: string, livemode: boolean): Promise<PdfResult>');
    // The signature live was running, which no caller in this repo can use.
    expect(PD).not.toContain('Promise<Uint8Array | null>');
  });

  it('and resolves the key per application rather than from a module constant', () => {
    const body = PD.slice(PD.indexOf('export async function downloadPdf'));
    expect(body).toContain('pandadocConfigFor(livemode)');
    expect(body).toContain('API-Key ${cfg.value.key}');
    // `KEY` is what live's copy referenced and never declared.
    expect(body.slice(0, 1200)).not.toMatch(/API-Key \$\{KEY\}/);
  });

  it('and never throws: every exit is a PdfResult', () => {
    const body = PD.slice(PD.indexOf('export async function downloadPdf'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    expect(fn).not.toMatch(/\bthrow\b/);
    expect(fn).toContain('} catch (e) {');
  });
});

describe('and the claim is released whatever goes wrong', () => {
  /* THE LESSON OF 14 OCTOBER, which was not a missing branch but a missing
     catch: `pdf.ok` threw, and a throw is not a branch, so none of the careful
     per-arm cleanup ran. */
  it('a failure before execution drops the dedup row and asks for a retry', () => {
    const i = DC.indexOf('if (!state.executed) {');
    expect(i).toBeGreaterThan(-1);
    const arm = DC.slice(i, i + 700);
    expect(arm).toContain('"pandadoc_events").delete().eq("id", evId)');
    expect(arm).toContain('retryable: true');
  });

  it('and a failure AFTER execution keeps it, or the deed is delivered twice', () => {
    expect(DC).toContain('state.executed = true;');
    const i = DC.indexOf('p_type: "deed_post_execution_failed"');
    expect(i).toBeGreaterThan(-1);
    // That arm must NOT release the claim.
    const arm = DC.slice(DC.indexOf('if (!state.executed) {'), i);
    const release = arm.lastIndexOf('"pandadoc_events").delete()');
    expect(release).toBeGreaterThan(-1);
    expect(DC.slice(i, i + 600)).not.toContain('"pandadoc_events").delete()');
  });

  it('and the guard wraps the whole sequence, not one arm of it', () => {
    const tryAt = DC.indexOf('return await runCompletion(');
    const catchAt = DC.indexOf('} catch (e) {', tryAt);
    expect(tryAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(tryAt);
  });
});
