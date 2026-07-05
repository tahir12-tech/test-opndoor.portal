/* =====================================================================
   Health (opndoor admin only, enforced by the route guard) - #7.
   The operational health page: is every cron alive and did its call actually
   succeed, plus the 24h failure counts and the backlog a human must clear.

   The headline concern is the silent-401 class: a cron whose run details say
   "succeeded" while the edge function actually answered 401. cron.job_run_details
   only reports that the `net.http_post(...)` was queued; the REAL HTTP status
   lives in net._http_response. The cron_health() RPC surfaces both, so a green
   "succeeded" sitting next to a red 401 is impossible to miss.

   Mock/test mode has no back end, so we show a friendly placeholder and the
   render smoke test stays meaningful.
   ===================================================================== */
import { useCallback, useEffect, useState } from 'react';
import { getCronHealth, type CronHealth } from '@/data';
import { SUPABASE_ENABLED } from '@/lib/supabase';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Card, CardHead } from '@/components/ui/Card';
import { Pill, type PillVariant } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import '@/components/ui/opbar.css';
import './Health.css';

/** dd/mm/yyyy HH:MM in local time; 'Never' when there is no timestamp. */
function fmtDateTime(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Never';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A short label for a run status, plus the pill colour to show it in. */
function runPill(status: string | null): { label: string; variant: PillVariant } {
  if (!status) return { label: 'Never run', variant: 'muted' };
  if (status === 'succeeded') return { label: 'Succeeded', variant: 'deed' };
  if (status === 'failed') return { label: 'Failed', variant: 'danger' };
  return { label: status, variant: 'warn' };
}

interface StatDef {
  label: string;
  value: number;
  /** Highlight in red when the value is non-zero (a failure metric). */
  bad?: boolean;
}

function StatGrid({ stats }: { stats: StatDef[] }) {
  return (
    <div className="hstat">
      {stats.map((s) => (
        <div key={s.label} className={`hstat__card${s.bad && s.value > 0 ? ' hstat__card--bad' : ''}`}>
          <div className="hstat__n">{s.value}</div>
          <div className="hstat__l">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

export function Health() {
  usePageMeta('health', 'Health', ['Home', 'opndoor', 'Health']);
  const toast = useToast();
  const [data, setData] = useState<CronHealth | null>(null);
  const [loading, setLoading] = useState(true);
  // #108 A visible "snapshot" time so Refresh has an observable effect even when the
  // underlying cron figures are unchanged.
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const reload = useCallback(async () => {
    if (!SUPABASE_ENABLED) { setLoading(false); return; }
    setLoading(true);
    try {
      setData(await getCronHealth());
      setRefreshedAt(new Date());
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load the health metrics.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void reload(); }, [reload]);

  const head = (
    <div className="page-head">
      <div>
        <div className="rec-eyebrow"><span className="opx">opndoor</span> · operational health</div>
        <h1 className="page-head__title" style={{ marginTop: 10 }}>Health</h1>
        <p className="page-head__sub">Cron liveness and the real HTTP outcome of each scheduled call, the last 24 hours of email, webhook and deed failures, and the backlog awaiting a human.</p>
      </div>
      {SUPABASE_ENABLED && (
        <div className="page-head__actions" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {refreshedAt && (
            <span style={{ fontSize: 12.5, color: 'var(--ink-mute)' }}>
              Snapshot {refreshedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void reload()}><Icon name="refresh" /> {loading ? 'Refreshing…' : 'Refresh'}</Button>
        </div>
      )}
    </div>
  );

  const opbar = (
    <div className="card opbar">
      <Icon name="shield" />
      <span>Visible to <b>opndoor admins</b> only. This is internal operational telemetry, not a partner-facing view.</span>
    </div>
  );

  // Mock/test mode: no back end to read. Keep the smoke test meaningful.
  if (!SUPABASE_ENABLED) {
    return (
      <>
        {head}
        {opbar}
        <div className="hplaceholder">Health metrics are available in the live environment.</div>
      </>
    );
  }

  if (loading && !data) {
    return (<>{head}{opbar}<div className="hplaceholder">Loading health metrics…</div></>);
  }

  if (!data) {
    return (<>{head}{opbar}<div className="hplaceholder">No health metrics are available right now.</div></>);
  }

  const c = data.counts;
  const n = data.needs_attention;
  // Any silent-success job (run said succeeded, HTTP said non-2xx) or a non-2xx
  // most-recent response, or any non-2xx in the window: make it loud.
  const silentJobs = data.jobs.filter((j) => j.last_status === 'succeeded' && j.http_ok === false);
  const showAlert = data.http_alert || c.http_errors > 0 || silentJobs.length > 0;

  return (
    <>
      {head}
      {opbar}

      {showAlert && (
        <div className="halert" role="alert">
          <Icon name="alert" />
          <div>
            <div className="halert__title">HTTP errors detected in the last 24 hours ({c.http_errors})</div>
            <div className="halert__sub">
              A cron can report <b>succeeded</b> while its edge function actually returned a non-2xx (the silent-401 class).
              Check the <b>Last HTTP</b> column and the recent responses below - the run status alone is not proof of success.
            </div>
          </div>
        </div>
      )}

      <Card style={{ marginBottom: 18 }}>
        <CardHead title="Scheduled jobs" sub="The last run of each cron, and the real HTTP status of its call." />
        <div className="table-wrap">
          <table className="dt hdt">
            <thead>
              <tr>
                <th>Job</th>
                <th>Schedule</th>
                <th>Active</th>
                <th>Last run</th>
                <th>Last outcome</th>
                <th>Last HTTP</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j) => {
                const rp = runPill(j.last_status);
                const httpBad = j.http_ok === false;
                const silent = j.last_status === 'succeeded' && httpBad;
                return (
                  <tr key={j.jobname}>
                    <td>
                      <div className="dt__name">{j.jobname}</div>
                      {j.last_return_message && <div className="dt__sub">{j.last_return_message}</div>}
                    </td>
                    <td><code className="hcode">{j.schedule}</code></td>
                    <td>{j.active ? <Pill variant="deed">Active</Pill> : <Pill variant="muted">Paused</Pill>}</td>
                    <td className="dt__num">{fmtDateTime(j.last_run)}</td>
                    <td>
                      <Pill variant={rp.variant}>{rp.label}</Pill>
                      {silent && <div className="hsilent">reported success</div>}
                    </td>
                    <td>
                      {j.http_status_code != null ? (
                        <span className={`hhttp${httpBad ? ' hhttp--bad' : ' hhttp--ok'}`}>{j.http_status_code}</span>
                      ) : j.http_ok === null && j.last_run ? (
                        <span className="hhttp hhttp--none" title="No HTTP response could be correlated to this run by time.">no match</span>
                      ) : (
                        <span className="hhttp hhttp--none">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card style={{ marginBottom: 18 }}>
        <CardHead title="Last 24 hours" sub="Failures the system already records, plus HTTP errors from the cron calls." />
        <div className="card__body">
          <StatGrid stats={[
            { label: 'Email sends', value: c.email_sends },
            { label: 'Email failures', value: c.email_failures, bad: true },
            { label: 'Webhook failures', value: c.webhook_failures, bad: true },
            { label: 'Deed failures', value: c.deed_failures, bad: true },
            { label: 'Anomalies', value: c.anomalies, bad: true },
            { label: 'HTTP errors', value: c.http_errors, bad: true },
          ]} />
        </div>
      </Card>

      <Card style={{ marginBottom: 18 }}>
        <CardHead title="Needs attention" sub="Operational backlog awaiting a human." />
        <div className="card__body">
          <StatGrid stats={[
            { label: 'Applications stuck at sent', value: n.stuck_sent, bad: true },
            { label: 'Awaiting tenant signature', value: n.awaiting_signature, bad: true },
            { label: 'Pending reconciliation', value: n.pending_reconciliation, bad: true },
            { label: 'Tenancy corrections to resolve', value: n.pending_tenancy_corrections, bad: true },
          ]} />
        </div>
      </Card>

      <Card style={{ marginBottom: 18 }}>
        <CardHead title="Recent HTTP responses" sub="The authoritative HTTP signal, straight from net._http_response." />
        <div className="table-wrap">
          <table className="dt hdt">
            <thead>
              <tr>
                <th>Status</th>
                <th>When</th>
                <th>Response</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_http.length === 0 && (
                <tr><td colSpan={3} className="dt__sub">No HTTP responses recorded yet.</td></tr>
              )}
              {data.recent_http.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className={`hhttp${r.ok ? ' hhttp--ok' : ' hhttp--bad'}`}>
                      {r.status_code != null ? r.status_code : r.timed_out ? 'timeout' : 'error'}
                    </span>
                  </td>
                  <td className="dt__num">{fmtDateTime(r.created)}</td>
                  <td><div className="hsnippet">{r.content ?? r.error_msg ?? '-'}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="hgenerated">Snapshot generated {fmtDateTime(data.generated_at)}.</div>
    </>
  );
}
