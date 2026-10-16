/* THE HUBSPOT SYNC CANNOT BE STOPPED FOR EVER BY ONE EVENT, AND ITS RPC
   SIGNATURE CANNOT DRIFT FROM THE MIGRATION THAT DEFINES IT.

   Reported as a recurring fault on the live portal: "a HubSpot sync error".
   Not one defect, three, and all three present identically: the CRM stops
   updating and the only evidence is one ops-alert that nobody connects to it.

     1. SIGNATURE DRIFT ACROSS A DEPLOY. 20260812030000 drops the four-argument
        hubspot_pending_events and creates a five-argument one. A bundle older
        than that migration calls a function that no longer exists, for every
        partner, on every run, for ever. The migration says so in its own
        comments and asks to be applied and deployed together. Nothing checked
        that the caller and the definition agree, so the first half of this
        file checks it, from the two files themselves.

     2. A POISONED QUEUE. The per-event handler breaks on error and holds the
        partner's cursor, so an event that can NEVER succeed is retried every
        two minutes and everything behind it is never synced. Partitioning the
        cursor per partner (also 20260812030000) shrank the blast radius; it
        put no floor under it. The floor is MAX_ATTEMPTS plus PARK_AFTER_MS,
        after which the event is parked in the ledger and the queue moves on.

     3. CONFIG GAPS THAT THREW. A partner with no hubspot_partner_map row threw
        `no partner map for partner_id ...`, which is defect 2 with a config
        cause: permanent, per partner, and silent after the first hour. Those
        are gated now, the way §6 already gates an unconfirmed org.

   IT READS THE SOURCE, and that is the point rather than a compromise. These
   are Deno edge functions: Deno is not installed here, so `deno test` cannot be
   the guard, and the function cannot be imported into vitest because it reaches
   Deno.env at module scope. What is checkable without a runtime is exactly the
   property that matters, which is structural. Same pattern, and same reason, as
   src/data/payLinkIsDurable.test.ts. */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SYNC = 'supabase/functions/hubspot-sync/index.ts';
const MIGRATIONS = 'supabase/migrations';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const src = read(SYNC);

/** The newest migration that creates public.hubspot_pending_events. */
function definingMigration(): { name: string; body: string } {
  const files = readdirSync(resolve(process.cwd(), MIGRATIONS))
    .filter((f) => f.endsWith('.sql'))
    .sort(); // timestamp-prefixed, so lexical order is apply order
  let found: { name: string; body: string } | null = null;
  for (const f of files) {
    const body = read(`${MIGRATIONS}/${f}`);
    if (/create\s+or\s+replace\s+function\s+public\.hubspot_pending_events/i.test(body)) found = { name: f, body };
  }
  if (!found) throw new Error('no migration defines hubspot_pending_events');
  return found;
}

/** The parameter names of that migration's hubspot_pending_events, in order. */
function declaredParams(body: string): string[] {
  const m = body.match(/create\s+or\s+replace\s+function\s+public\.hubspot_pending_events\s*\(([\s\S]*?)\)\s*returns/i);
  if (!m) throw new Error('could not read the parameter list');
  return [...m[1].matchAll(/\b(p_[a-z_]+)\b/g)].map((x) => x[1]);
}

/** The column names of its returns table, in order. */
function declaredColumns(body: string): string[] {
  const m = body.match(/hubspot_pending_events[\s\S]*?returns\s+table\s*\(([\s\S]*?)\)\s*\n?\s*language/i);
  if (!m) throw new Error('could not read the returns table');
  return m[1].split(',').map((c) => c.trim().split(/\s+/)[0]);
}

/** The keys the function passes to one named rpc, from its object literal. */
function rpcKeys(rpc: string): string[] {
  const m = src.match(new RegExp(`rpc\\(\\s*"${rpc}"\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*\\)`));
  if (!m) return [];
  return [...m[1].matchAll(/\b(p_[a-z_]+)\s*:/g)].map((x) => x[1]);
}

describe('hubspot-sync agrees with the migration that defines its queue', () => {
  const mig = definingMigration();

  it('the defining migration is found and is the partitioned one', () => {
    // A canary: if this stops being the five-argument migration the parsing
    // below is reading something else and every assertion is passing over air.
    expect(mig.name).toMatch(/^\d{14}_/);
    expect(declaredParams(mig.body)).toContain('p_partner');
  });

  it('passes exactly the arguments the function declares, by name', () => {
    // Supabase rpc passes named arguments, so a renamed or added parameter is
    // a PGRST202 at runtime and nothing else. This is the check that a stale
    // deployment fails on paper before it fails in production.
    expect(rpcKeys('hubspot_pending_events').sort()).toEqual(declaredParams(mig.body).sort());
  });

  it('reads only columns the function returns', () => {
    const columns = new Set(declaredColumns(mig.body));
    const readByCode = new Set([...src.matchAll(/\bev\.([a-z_]+)\b/g)].map((m) => m[1]));
    expect(readByCode.size).toBeGreaterThan(0);
    for (const col of readByCode) expect(columns.has(col)).toBe(true);
  });

  it('leaves no older signature callable', () => {
    // A surviving four-argument overload is worse than a hard failure: an
    // un-updated caller resolves to the unpartitioned queue and the head-of-
    // line blocking comes back with nothing on the surface to show for it.
    expect(mig.body).toMatch(/drop function if exists public\.hubspot_pending_events\(timestamptz/i);
  });

  it('marks the cursor with the arguments that function declares too', () => {
    const body = read(`${MIGRATIONS}/${mig.name}`);
    const m = body.match(/create\s+or\s+replace\s+function\s+public\.hubspot_mark_cursor\s*\(([\s\S]*?)\)\s*returns/i);
    const declared = [...(m?.[1] ?? '').matchAll(/\b(p_[a-z_]+)\b/g)].map((x) => x[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(rpcKeys('hubspot_mark_cursor').sort()).toEqual(declared.sort());
  });
});

describe('one event can no longer stop a partner for ever', () => {
  it('bounds the retry with a count AND a clock, both finite', () => {
    const attempts = Number(src.match(/const MAX_ATTEMPTS = (\d+)/)?.[1]);
    const grace = src.match(/const PARK_AFTER_MS = ([^;]+);/)?.[1] ?? '';
    expect(Number.isFinite(attempts)).toBe(true);
    expect(attempts).toBeGreaterThan(1);
    // Generous enough to ride out a HubSpot incident, short enough that a
    // permanent fault is not a permanent outage.
    // eslint-disable-next-line no-eval
    const ms = Number(eval(grace));
    expect(ms).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });

  it('parks the event, advances past it and continues the queue', () => {
    // The three halves of "does not block": a record of what was skipped, a
    // cursor that moved, and a `continue` rather than the `break`.
    const park = src.match(/if \(park\) \{[\s\S]*?\n {10}\}/);
    expect(park, 'no park branch in the per-event catch').not.toBeNull();
    expect(park![0]).toMatch(/DEAD_LETTER/);
    expect(park![0]).toMatch(/hubspot_mark_cursor/);
    expect(park![0]).toMatch(/\bcontinue;/);
  });

  it('counts attempts against the event, not the run', () => {
    // A counter held in memory resets every two minutes and never reaches the
    // limit, which is the shape this failed as before.
    expect(src).toMatch(/\.eq\("event_id", ev\.event_id\)\s*\.eq\("target", FAILED\)/);
    expect(src).toMatch(/fail:\$\{ev\.event_id\}:\$\{attempts\}/);
  });
});

describe('config gaps are gated, not thrown', () => {
  it('a partner with no map row does not throw', () => {
    // The exact string of the old defect. Every partner created after the seed
    // migration ran has a cursor and no map row, so this threw on every event
    // they have ever produced.
    expect(src).not.toMatch(/throw new Error\(`no partner map/);
    expect(src).toMatch(/configGap\(`no active hubspot_partner_map row/);
  });

  it('a partner company missing from the Hub does not throw', () => {
    expect(src).not.toMatch(/throw new Error\(`partner company .* not found in HubSpot/);
    expect(src).toMatch(/configGap\(`partner company \$\{pm\.partner_company_key\} does not exist in HubSpot/);
  });

  it('an unset association type id does not become a HubSpot 400', () => {
    // The production hubspot_sync_env row ships with company_branch_type_id
    // null, so promotion without setting it would poison every event.
    expect(src).toMatch(/env\.company_branch_type_id == null/);
    expect(src).toMatch(/env\.company_parent_type_id == null/);
  });
});

describe('a failure this function cannot recover from is audible', () => {
  /** Every `return json({ ok: false, ... }, 500)` in the file, with what precedes it. */
  const fatalReturns = [...src.matchAll(/return json\(\{ ok: false[^;]*?\}, 500\);/g)];

  it('has fatal exits to check', () => {
    expect(fatalReturns.length).toBeGreaterThanOrEqual(4);
  });

  for (const m of fatalReturns) {
    const before = src.slice(Math.max(0, m.index! - 700), m.index!);
    const label = m[0].slice(0, 60);
    it(`alerts before returning: ${label}`, () => {
      // A 500 from a cron-invoked function is recorded only as a non-2xx row
      // in net._http_response. That is not a signal anybody watches, which is
      // how "nothing has synced for a week" stays invisible for a week.
      expect(before).toMatch(/await incident\(/);
    });
  }

  it('never raises the bare alert type, because ops_alerts dedupes on it', () => {
    // ops_alerts_dedupe is (alert_type, coalesce(application_id, zero),
    // hour_bucket) and this function always passes a null application. With an
    // un-suffixed type the FIRST partner to fail in an hour silenced every
    // other partner for the rest of it. Same convention as cron_error:<job>.
    const types = [...src.matchAll(/incident\(\s*[`"]([^`"$]*)/g)].map((x) => x[1]);
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect(t).not.toBe('hubspot_sync_error');
    expect(src).not.toMatch(/p_type: "hubspot_sync_error"/);
    // and the prefix survives, so existing greps and ops_alerts filters match
    for (const t of types) expect(t.startsWith('hubspot_sync_error')).toBe(true);
  });

  it('checks the writes that record progress', () => {
    // supabase-js returns errors rather than throwing them, so an unchecked
    // `await` on these two discards the only evidence: the cursor silently not
    // advancing (every run redoes the same events) and the ledger silently not
    // recording (associations never settle).
    expect(src).toMatch(/const \{ error: curErr \} = await service\.rpc\("hubspot_mark_cursor"/);
    expect(src).toMatch(/if \(curErr\) throw new Error/);
    expect(src).toMatch(/if \(err\) throw new Error\(`ledger write/);
  });
});

/* AND THE AGENCY ROUTE ASKS HUBSPOT FOR NOTHING.
 *
 * Live, 15 October 16:46: "partner company PARTNER:opndoor-agents does not
 * exist in HubSpot, so the PRIMARY partner association cannot be made", and
 * 17:18 the same for PARTNER:reference-my-tenant. The second is a real gap, a
 * commercial counterparty whose company has gone missing. The first is not:
 * there is no Opndoor partner company and there should not be one.
 *
 * Matt, 2026-10-15: applications on the agency route "must NOT be associated to
 * any Opndoor/placeholder partner company in HubSpot. They should link only to
 * the agency's own company and branch (e.g. Regent). Partner associations stay
 * as they are for real partners."
 *
 * The decision lives in hubspot_partner_map.associate_partner_company
 * (20261015130000), because the sync loads that table with select("*") and so
 * a column arrives in `pm` with no change to the loading code. The database
 * half is pinned in hubspot_sync_queue_is_wired.test.sql; this is the half that
 * has to be read off the source, because hubspot-sync is a Deno function.
 */
describe('the agency route has no partner company', () => {
  it('skips the partner association when config says there is none', () => {
    expect(src).toContain('} else if (pm.associate_partner_company === false) {');
  });

  /* THE WHOLE POINT: no alert. Raising one was the fault, not the finding. */
  it('and raises no config gap for it', () => {
    const i = src.indexOf('pm.associate_partner_company === false');
    const j = src.indexOf('} else {', i);
    expect(i).toBeGreaterThan(-1);
    // The CALL, not the word: the branch's own comment explains why there is
    // no configGap here, so a bare substring test matches its own rationale.
    expect(src.slice(i, j)).not.toContain('await configGap(');
  });

  /* RECORDED, NOT SILENT. The same ledger key the real association writes, so
     the work is never reconsidered and 20261006130000's replay cannot pick
     these applications up for an association they must not have. The target
     differs so the table says which of the two happened. */
  it('but records the skip under the same ledger key, with its own target', () => {
    const i = src.indexOf('pm.associate_partner_company === false');
    const arm = src.slice(i, src.indexOf('} else {', i));
    expect(arm).toContain('`assoc:${app.id}:partner`');
    expect(arm).toContain('"assoc_partner_skipped"');
  });

  /* `=== false`, NOT `!pm.associate_partner_company`. On a database where the
     migration has not landed the column is undefined, and the loose test would
     skip the association for EVERY partner including the real ones. The strict
     test fails safe to the old behaviour. */
  it('and fails safe on a database without the column', () => {
    // Anchored on `if (`, for the same reason: the comment above the branch
    // quotes the loose form in order to rule it out.
    expect(src).not.toMatch(/if \(!pm\.associate_partner_company/);
    expect(src).not.toMatch(/else if \(!pm\.associate_partner_company/);
    // And the strict comparison is the one actually present.
    expect(src).toContain('pm.associate_partner_company === false');
  });

  /* The real gap must still be reported. If this ever passes vacuously the
     reference-my-tenant class of fault goes quiet. */
  it('while a real partner with a missing company still raises the gap', () => {
    expect(src).toContain('does not exist in HubSpot, so the PRIMARY partner association cannot be made');
  });
});
