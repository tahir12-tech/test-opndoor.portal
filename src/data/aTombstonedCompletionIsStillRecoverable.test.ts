/* A DEDUP ROW IS NOT PROOF THE WORK FINISHED.
 *
 * GR-20611 and GR-20612, live, 14 October 2026. Both tenants paid (£600 and
 * £1,488.46), both signed within minutes of being sent the deed, and live
 * recorded neither. What the live tables actually say:
 *
 *   GwUTtbHjaVwCQUYjzPuBMK:document.viewed     13:05:59  application_id SET
 *   GwUTtbHjaVwCQUYjzPuBMK:document.completed  13:14:48  application_id NULL
 *   ops_alerts webhook_error, bucket 13:00:
 *     "pandadoc-webhook: Cannot read properties of null (reading 'ok')"
 *
 * The viewed row carries an application_id, so the lookup works. The completed
 * row does not, so the handler never reached the write that follows execution.
 * deed_state is still 'awaiting_tenant' and executed_pdf_path is null, so
 * apply_deed_executed never succeeded. Between those two points the only `.ok`
 * read is `pdf.ok`, and the alert says something was null when `.ok` was read.
 *
 * So: downloadPdf returned null, `pdf.ok` threw, and the delete that would have
 * released the dedup row sits INSIDE the branch the throw stopped us reaching.
 * PandaDoc retried, hit the primary key, and the handler answered 200. The row
 * became a tombstone: a committed claim with no work behind it and nothing that
 * could ever re-present the event.
 *
 * It is a RACE, not an artefact of that evening's deploy. PandaDoc fires
 * document.completed before it renders the signed PDF, which this codebase
 * already knew: see the comment in _shared/deedCompletion.ts. Nine minutes for
 * GR-20611, three for GR-20612. Any tenant who signs that fast loses their deed.
 *
 * THE FIRST VERSION OF THE SWEEP'S LOCK MADE THIS PERMANENT. It inserted the
 * same id and read 23505 as "the webhook has it, or had it. Either way not ours
 * to do", so it would have skipped both deeds every hour for ever. Worse, the
 * dry run reported them under wouldReconcile, because that check sat BEFORE the
 * lock attempt: it promised work the real run would not do.
 *
 * WHAT MAKES ADOPTION SAFE. The candidate query (deeds_awaiting_completion)
 * selects only status = 'paid' with deed_state not in executed/voided/declined,
 * so anything it returns is unfinished work BY CONSTRUCTION, whatever
 * pandadoc_events says. The dedup row's age is then the only open question: a
 * fresh one may have a webhook behind it, an old one cannot.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { completionLockVerdict } from '../../supabase/functions/_shared/completionLock.ts';

const NOW = '2026-10-15T13:00:00.000Z';
const minutesBefore = (n: number) =>
  new Date(Date.parse(NOW) - n * 60_000).toISOString();

describe('an old dedup row with no work behind it', () => {
  /* THE ACTUAL ROW, at the actual time, against a sweep running the next day. */
  it('is adopted, which is what recovers GR-20611', () => {
    expect(completionLockVerdict('2026-10-14 13:14:48.295273+00', NOW)).toBe('adopt');
  });

  it('and GR-20612, whose completion came in as recipient_completed', () => {
    expect(completionLockVerdict('2026-10-14 17:09:05.809678+00', NOW)).toBe('adopt');
  });

  it('and so is one from an hour ago, because the sweep runs hourly', () => {
    expect(completionLockVerdict(minutesBefore(60), NOW)).toBe('adopt');
  });
});

describe('a fresh dedup row', () => {
  /* A WEBHOOK IS PROBABLY HOLDING IT RIGHT NOW. An edge function invocation is
     bounded in seconds, so a claim this young belongs to a live request, and
     stepping on it is how one signature becomes two deliveries. Waiting costs
     one hour; the sweep will be back. */
  it('is left alone: something is probably working on it', () => {
    expect(completionLockVerdict(minutesBefore(0.5), NOW)).toBe('wait');
  });

  it('and still at fourteen minutes and fifty-nine seconds', () => {
    expect(completionLockVerdict(minutesBefore(14 + 59 / 60), NOW)).toBe('wait');
  });

  it('but not at fifteen, which is far beyond any invocation', () => {
    expect(completionLockVerdict(minutesBefore(15), NOW)).toBe('adopt');
  });

  it('and the threshold is an argument, so a caller that knows better can say so', () => {
    expect(completionLockVerdict(minutesBefore(20), NOW, 30)).toBe('wait');
    expect(completionLockVerdict(minutesBefore(40), NOW, 30)).toBe('adopt');
  });
});

describe('a row we cannot date', () => {
  /* received_at is `timestamptz not null default now()`, so this cannot happen
     from the normal path and the question is only which way to fail.

     ADOPT. The two outcomes are not symmetrical. Losing it means a tenant who
     paid and signed never receives their deed, for ever, with nothing left that
     could re-present the event. Adopting it risks a second delivery, and a
     second delivery is ALREADY guarded: the completion sequence checks
     `deliverable && mayEmail && app.deed_delivered_at` and writes
     "Completion replayed" instead of sending. So the worse failure is the one
     with no guard behind it. */
  it('is adopted rather than lost, because the two failures are not equal', () => {
    expect(completionLockVerdict(null, NOW)).toBe('adopt');
    expect(completionLockVerdict(undefined, NOW)).toBe('adopt');
    expect(completionLockVerdict('not a timestamp', NOW)).toBe('adopt');
    expect(completionLockVerdict('', NOW)).toBe('adopt');
  });

  /* EXCEPT A ROW FROM THE FUTURE, which is clock skew between the database and
     the function host. The age is then not a number we can reason about, and
     unlike an undateable row this one plainly WAS written recently. Treated as
     fresh. */
  it('but a future-dated row is treated as fresh, not as infinitely old', () => {
    expect(completionLockVerdict('2026-10-15T13:05:00.000Z', NOW)).toBe('wait');
  });
});

/* AND THE SWEEP HAS TO ACTUALLY ASK. The decision above is worth nothing if the
   lock arm still reads 23505 as an unconditional skip, so the wiring is pinned
   too. Source assertions, in the pattern aCorrectedDeedIsDeliveredToo.test.ts
   established: these are Deno edge functions and cannot be executed here. */
const SWEEP = readFileSync(join(process.cwd(), 'supabase/functions/deed-sweep/index.ts'), 'utf8');
const SHARED = readFileSync(join(process.cwd(), 'supabase/functions/_shared/deedCompletion.ts'), 'utf8');

describe('the sweep consults the verdict rather than giving up', () => {
  it('reads the existing row instead of treating a duplicate key as done', () => {
    expect(SWEEP).toContain('completionLockVerdict');
    // The old wording, which is the bug, must be gone.
    expect(SWEEP).not.toContain('Either way not ours to do');
  });

  it('and the duplicate-key path is the one that asks', () => {
    const dup = SWEEP.indexOf('23505');
    expect(dup).toBeGreaterThan(-1);
    // The verdict is consulted AFTER the duplicate is recognised, which is the
    // branch that used to `continue` unconditionally.
    const asks = SWEEP.indexOf('completionLockVerdict', dup);
    expect(asks).toBeGreaterThan(dup);
  });

  it('and the age it judges comes from the row itself', () => {
    // Not from the candidate list, which carries no event timestamp: the claim
    // being judged is the one in pandadoc_events.
    expect(SWEEP).toContain('.select("received_at").eq("id", evId)');
  });

  /* THE DRY RUN MUST NOT PROMISE WHAT THE REAL RUN WILL NOT DO. It reported
     wouldReconcile for both deeds while the real run would have skipped them,
     which is the worst shape a safety check can take: the person reading it
     has stopped watching. */
  it('and a dry run reports what is blocked instead of counting it as work', () => {
    expect(SWEEP).toContain('blockedByFreshLock');
  });
});

describe('and the line that cost two deeds is null-safe', () => {
  /* Our own downloadPdf cannot return null. Live's can: its pandadoc-webhook
     was redeployed separately (section 16.5, never reconciled) and Balal's
     origin/main carries "Pandadoc logic same for testing delay if not yet
     downloade deed". The helper should not be one undefined away from a
     permanent loss. */
  it('checks the result exists before reading ok', () => {
    expect(SHARED).toContain('if (!pdf || !pdf.ok || !pdf.bytes)');
  });
});
