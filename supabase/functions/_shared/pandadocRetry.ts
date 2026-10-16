// =====================================================================
// HOW LONG TO KEEP ASKING FOR A SIGNED PDF THAT IS NOT RENDERED YET.
//
// PandaDoc fires document.completed BEFORE the signed PDF exists and answers
// 409 while it renders, so one immediate fetch loses the race for no reason.
// Balal's version on live waits twelve seconds, a second at a time, and that
// part of it was right.
//
// THIS IS THE POLICY ONLY, with no imports and no Deno, so vitest can execute
// it rather than read it off the source. The same arrangement as
// _shared/completionLock.ts and _shared/emailTemplates.ts, and for the same
// reason: a loop that decides when to stop waiting for a legal document is
// worth testing properly, and the rest of pandadoc.ts cannot be imported here.
// =====================================================================

/** How long to keep asking while PandaDoc is still rendering. */
export const DOWNLOAD_RENDER_BUDGET_MS = 12_000;

/** Wait this many ms and ask again, or stop and report what went wrong. */
export type RetryVerdict = { wait: number } | { giveUp: true };

/**
 * `status` is PandaDoc's HTTP status, or null when the fetch itself threw.
 *
 * ONLY "STILL RENDERING" AND A THROWN FETCH ARE WORTH WAITING FOR. A 401, 403
 * or 404 will not become a PDF by being asked again, and spending the budget on
 * one delays the honest failure the caller needs in order to release its claim
 * and let PandaDoc redeliver. A thrown fetch is a network blip and does deserve
 * another go.
 */
export function downloadRetryVerdict(
  status: number | null,
  elapsedMs: number,
  budgetMs: number = DOWNLOAD_RENDER_BUDGET_MS,
): RetryVerdict {
  const retryable = status === 409 || status === null;
  if (!retryable) return { giveUp: true };

  const left = budgetMs - elapsedMs;
  if (left <= 0) return { giveUp: true };

  /* Never sleep past the budget. Without the clamp a 409 at 11.9 seconds would
     sleep a full second and ask again at 12.9, which is a request made after we
     had decided to stop and, on an edge function, a second of wall clock spent
     after the answer was already known. */
  return { wait: Math.min(1000, left) };
}
