// =====================================================================
// Stripe key mode guard, shared by payment-page, stripe-webhook and
// create-referral.
//
// The problem this solves: those three functions previously hardcoded
// `startsWith("sk_live_")`, so a test key was rejected everywhere. That made the
// payment path impossible to exercise on any non-production project, and the
// only way to make a dev project work was to install live Stripe credentials on
// it, which risks real cards being charged from a disposable environment.
//
// The rule here is symmetric: the key mode must MATCH the project it is running
// on. A non-production project requires sk_test_, and everything else requires
// sk_live_. That blocks both accidents, not just the one.
//
// Why the project ref and not an env var: SUPABASE_URL is injected by the
// platform, and Supabase reserves the SUPABASE_ prefix so it cannot be set or
// overridden with `supabase secrets set`. An operator therefore cannot relax
// production from the dashboard. A plain ALLOW_TEST_STRIPE flag would put
// production's safety behind a value anyone with dashboard access could change.
//
// Fail closed: an unrecognised ref (including a missing or malformed
// SUPABASE_URL) falls through to requiring sk_live_. A new environment must be
// added to NON_PRODUCTION_REFS in a reviewed change before it can use test keys,
// rather than defaulting to permissive.
//
// Production needs no configuration change for this: its behaviour is identical
// to the previous hardcoded guard.
// =====================================================================

// Non-production projects, which must use test keys.
// xogpsaoyprgmxdkmcype (portal.opndoor.Live) is deliberately absent.
const NON_PRODUCTION_REFS = new Set<string>([
  //  "nfufwcpgrhfgwtphegca", // opndoor-matt-dev
    "updniardvylhsiavtncw" // testing project

]);

/** The project ref this function is running on, or "" if it cannot be determined. */
function projectRef(): string {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  return /https:\/\/([a-z]{20})\./.exec(url)?.[1] ?? "";
}

/**
 * Whether this deployment is a non-production project.
 *
 * Exported because livemodeCredentials.ts needs it for one specific decision: a
 * missing sandbox secret may fall back to the base secret ONLY here, where the
 * base secret is itself a test credential. On production the same fallback would
 * charge a real card for a sandbox rehearsal.
 */
export function isNonProductionProject(): boolean {
  return NON_PRODUCTION_REFS.has(projectRef());
}

/** Which Stripe key prefix this project requires. */
export function requiredStripePrefix(): "sk_test_" | "sk_live_" {
  return isNonProductionProject() ? "sk_test_" : "sk_live_";
}

/**
 * Returns an error message when the configured Stripe key is the wrong mode for
 * this project, or null when it is correct. Callers keep their own response
 * shape; this only decides the message.
 *
 * SUPERSEDED FOR ANYTHING THAT HAS AN APPLICATION. This checks the project only,
 * which was the whole story when a project was either live or test. Now that
 * sandbox lives inside the live system, a live project legitimately holds an
 * sk_test_ key as well, and the question "is this key right" has no answer
 * without knowing which application is being charged. Use
 * stripeSecretFor(livemode) in livemodeCredentials.ts, which composes this rule
 * with the per-application one. This is kept for callers with no application in
 * hand and for the environment banner generator, which reads NON_PRODUCTION_REFS
 * out of this file.
 */
export function stripeKeyModeError(secret: string): string | null {
  const want = requiredStripePrefix();
  if (secret.startsWith(want)) return null;
  return want === "sk_test_"
    ? "This is a non-production project and requires an sk_test_ key."
    : "Stripe is not configured for live mode. An sk_live_ key is required.";
}
