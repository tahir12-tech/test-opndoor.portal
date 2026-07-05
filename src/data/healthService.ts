/* =====================================================================
   Health service (opndoor admin only). #7.
   A single read of the cron_health() RPC: cron liveness plus the REAL HTTP
   outcome of each cron call. The point is the silent-401 class: a cron whose
   job_run_details says "succeeded" while the edge function actually answered
   401. That HTTP status lives in net._http_response (a non-public schema), so
   only the SECURITY DEFINER, admin-gated RPC can read it.

   Returns null in mock/test mode (no back end) so the page renders a friendly
   placeholder and the render smoke test stays meaningful.
   ===================================================================== */
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';

/** One cron job: schedule, its latest run, and a best-effort HTTP outcome. */
export interface CronJobHealth {
  jobname: string;
  schedule: string;
  active: boolean;
  /** cron.job_run_details.status. WARNING: "succeeded" even on a silent 401. */
  last_status: string | null;
  last_return_message: string | null;
  /** ISO timestamp of the last run start, or null if it has never run. */
  last_run: string | null;
  last_end: string | null;
  /** Best-effort correlated net._http_response status (by time). null if none. */
  http_status_code: number | null;
  http_created: string | null;
  /** true = 2xx, false = non-2xx, null = no correlated response. */
  http_ok: boolean | null;
}

/** A recent net._http_response row: the authoritative HTTP signal. */
export interface RecentHttp {
  id: number;
  status_code: number | null;
  ok: boolean;
  created: string;
  content: string | null;
  error_msg: string | null;
  timed_out: boolean;
}

/** 24h failure/volume counts drawn from signals the system already records. */
export interface HealthCounts {
  window_hours: number;
  email_sends: number;
  email_failures: number;
  webhook_failures: number;
  deed_failures: number;
  anomalies: number;
  /** Non-2xx (or errored) HTTP responses in the window: the silent-401 tally. */
  http_errors: number;
}

/** Operational backlog a human needs to clear. */
export interface NeedsAttention {
  stuck_sent: number;
  awaiting_signature: number;
  pending_reconciliation: number;
  pending_tenancy_corrections: number;
}

export interface CronHealth {
  generated_at: string;
  /** true when the single most recent HTTP response was not a 2xx. */
  http_alert: boolean;
  jobs: CronJobHealth[];
  recent_http: RecentHttp[];
  counts: HealthCounts;
  needs_attention: NeedsAttention;
}

/**
 * Read the operational health snapshot. Returns null in mock/test mode
 * (no back end); otherwise calls the admin-gated cron_health() RPC. The RPC
 * self-gates to an AAL2 admin, so a non-admin caller gets a thrown error.
 */
export async function getCronHealth(): Promise<CronHealth | null> {
  if (!SUPABASE_ENABLED) return null;
  const { data, error } = await sb().rpc('cron_health');
  if (error) throw new Error(error.message);
  return (data ?? null) as CronHealth | null;
}
