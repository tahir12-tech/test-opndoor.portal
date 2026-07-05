/* =====================================================================
   The ONLY module in the app that touches localStorage.
   The prototype used localStorage as a back-end stand-in. Screens never
   import this directly — they go through the service layer, which uses
   these helpers to persist mock data across reloads.

   INTEGRATION: when a real back end lands, the services that persist via
   these helpers become fetch() calls. This module can then be deleted or
   kept only for genuinely client-side preferences (selected partner/period).
   ===================================================================== */

/** Namespaced localStorage keys used by the prototype data layer. */
export const KEYS = {
  partners: 'grp_partners_v2',
  org: 'grp_org_v3', // v3 adds agent contacts to agencies and branches
  help: 'grp_help_v8', // v8 (#110): shipped Help documents + per-resource minRole gating
  role: 'grp_role',
  partner: 'grp_partner',
  period: 'grp_period',
  notifRead: 'grp_notif_read_v1', // per-user "notifications last read" timestamps
} as const;

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Over quota (e.g. a large uploaded help file). Callers surface this to the user.
    return false;
  }
}

export function loadString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Deep clone a seed so callers can mutate their working copy without touching the seed. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
