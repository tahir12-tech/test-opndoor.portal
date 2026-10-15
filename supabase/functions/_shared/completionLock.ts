// =====================================================================
// IS THIS DEDUP ROW A CLAIM, OR A TOMBSTONE?
//
// pandadoc_events is the mutual exclusion between the two completion paths:
// both the webhook and deed-sweep insert `<document>:document.completed` before
// doing any of the work, so whichever is second is refused by the primary key.
//
// The first version of the sweep read that refusal as "done" and skipped. On
// live, on 14 October 2026, that would have made two signed deeds unrecoverable
// for ever. GR-20611's completion arrived at 13:14:48, the row committed, and
// then `downloadPdf` returned null and `pdf.ok` threw -- which happens BEFORE
// the branch that releases the row. PandaDoc retried, hit the primary key, and
// the handler answered 200. A committed claim with no work behind it, and
// nothing left that could ever re-present the event.
//
// SO THE ROW'S AGE IS THE QUESTION, AND IT IS THE ONLY QUESTION. Whether the
// work finished is already settled before this function is called:
// deeds_awaiting_completion selects only `status = 'paid'` with deed_state not
// in (executed, voided, declined), so every candidate is unfinished work BY
// CONSTRUCTION, whatever pandadoc_events says. What remains is whether somebody
// is working on it THIS SECOND.
//
// An edge function invocation is bounded in seconds. A claim younger than the
// threshold therefore belongs to a live request and must be left alone, because
// stepping on it is how one signature becomes two deliveries. An older one
// cannot have a request behind it.
//
// NO IMPORTS, NO Deno, ON PURPOSE. This is the one decision in the completion
// path that can be tested properly rather than asserted off the source, so it
// lives where vitest can import it. See
// src/data/aTombstonedCompletionIsStillRecoverable.test.ts, and
// _shared/emailTemplates.ts for the same arrangement.
// =====================================================================

/** `adopt`: take over the claim and do the work. `wait`: leave it this round. */
export type LockVerdict = "adopt" | "wait";

/** Minutes after which a claim cannot still have a live request behind it. */
export const LOCK_STALE_AFTER_MINUTES = 15;

export function completionLockVerdict(
  receivedAtIso: string | null | undefined,
  nowIso: string,
  staleAfterMinutes: number = LOCK_STALE_AFTER_MINUTES,
): LockVerdict {
  const now = Date.parse(nowIso);
  // Postgres prints `2026-10-14 13:14:48.295273+00`, with a space rather than a
  // T. Date.parse handles it in V8, but the substitution costs nothing and the
  // alternative is a silent NaN that decides a deed's fate.
  const seen = receivedAtIso ? Date.parse(String(receivedAtIso).replace(" ", "T")) : NaN;

  /* A ROW WE CANNOT DATE IS ADOPTED, and the two outcomes are not symmetrical.
     received_at is `timestamptz not null default now()`, so this cannot arise
     from the normal path; the only question is which way to fail.

     Losing it means a tenant who paid and signed never receives their deed, for
     ever, with nothing left to re-present the event. Adopting it risks a second
     delivery, and a second delivery is already guarded: the completion sequence
     tests `deliverable && mayEmail && app.deed_delivered_at` and writes
     "Completion replayed" instead of sending. The worse failure is the one with
     no guard behind it. */
  if (!Number.isFinite(seen) || !Number.isFinite(now)) return "adopt";

  /* EXCEPT FROM THE FUTURE, which is clock skew between the database and the
     function host. The age is then not a number worth reasoning about, and
     unlike an undateable row this one plainly was written recently. Fresh. */
  if (seen > now) return "wait";

  return now - seen >= staleAfterMinutes * 60_000 ? "adopt" : "wait";
}
