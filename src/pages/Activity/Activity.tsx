/* =====================================================================
   Activity — a consolidated activity feed plus the upcoming-expiries view,
   both scoped by role and partner. Reached from the "View all activity" link
   in the notifications popover.

   Upcoming expiries shows what is lapsing soon, with a "reminders sent" count per
   guarantee. The proactive reminders (30/14/7 then daily) are the scheduled
   expiry-reminders Edge Function (pg_cron, 08:00 Europe/London); opndoor admin can
   run that job now in test mode here. See supabase/EXPIRY-REMINDERS.md.
   ===================================================================== */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getActivity, getActivityFeed, getAwaitingSignature, getUpcomingExpiries, runExpiryReminders, type ActivityFeedItem, type ActivityKind, type ExpiryBand } from '@/data';
import { useSession } from '@/session/SessionContext';
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';
import { hydrateFromSupabase } from '@/lib/hydrate';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHead } from '@/components/ui/Card';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Icon } from '@/components/ui/Icon';
import { Pill, type PillVariant } from '@/components/ui/Pill';
import { Pager } from '@/components/ui/Pager';
import { useToast } from '@/components/ui/Toast';
import './Activity.css';

const FEED_PAGE_SIZE = 20;
const dmy = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
// dd/mm/yyyy · HH:mm — used for real, activity_log-sourced events.
const dmyTime = (d: Date) => `${dmy(d)} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const KIND_DOT: Record<ActivityKind, string> = { sent: 'var(--sent)', paid: 'var(--paid)', deed: 'var(--deed)', withdrawn: 'var(--ink-mute, #7a7a8c)' };
const BAND_PILL: Record<ExpiryBand, PillVariant> = { soon: 'danger', warn: 'warn', notice: 'sent', later: 'muted' };

function activityText(kind: ActivityKind, tenant: string) {
  if (kind === 'paid') return <>Guarantor fee paid for <b>{tenant}</b></>;
  if (kind === 'deed') return <>Deed of Guarantee issued for <b>{tenant}</b></>;
  if (kind === 'withdrawn') return <>Referral withdrawn for <b>{tenant}</b></>;
  return <>Referral sent for <b>{tenant}</b></>;
}

// Live feed (activity_log) label + dot per raw kind, tenant-inclusive.
function feedText(kind: string, tenant: string) {
  const t = <b>{tenant}</b>;
  switch (kind) {
    case 'payment_received': return <>Guarantor fee paid for {t}</>;
    case 'refunded': return <>Guarantor fee refunded for {t}</>;
    case 'deed_sent': return <>Deed sent to {t} for signature</>;
    case 'deed_viewed': return <>Deed viewed by {t}</>;
    case 'deed_signed': return <>Deed signed by {t}</>;
    case 'deed_issued': return <>Deed of Guarantee issued for {t}</>;
    case 'deed_delivered': return <>Deed of Guarantee delivered to the agent for {t}</>;
    case 'deed_undelivered': return <>Deed issued for {t}, no agent contact on file</>;
    case 'deed_regenerated': return <>Deed regenerated for {t}</>;
    case 'deed_reissued': return <>Deed reissued for {t}</>;
    case 'tenancy_amended': return <>Tenancy start amended for {t}</>;
    default: return <>Referral sent for {t}</>; // referral_created
  }
}
function feedDot(kind: string): string {
  if (kind === 'payment_received') return 'var(--paid)';
  if (kind === 'refunded' || kind === 'deed_undelivered') return 'var(--danger, #d64545)';
  if (kind === 'deed_signed' || kind === 'deed_issued' || kind === 'deed_reissued' || kind === 'deed_regenerated' || kind === 'deed_delivered') return 'var(--deed)';
  return 'var(--sent)'; // referral_created, deed_sent, deed_viewed, tenancy_amended
}
interface FeedRow { id: string; ref: string; dot: string; text: ReactNode; meta: string; }
function untilText(daysUntil: number): string {
  if (daysUntil <= 0) return 'expires today';
  if (daysUntil === 1) return 'expires tomorrow';
  return `expires in ${daysUntil} days`;
}

export function Activity() {
  usePageMeta('activity', 'Activity', ['Home', 'Activity']);
  const { role, partnerScope } = useSession();
  const toast = useToast();
  const [refreshTick, forceRefresh] = useState(0);
  const [running, setRunning] = useState(false);

  const expiries = getUpcomingExpiries({ role, scope: partnerScope });
  const awaitingSig = getAwaitingSignature(role, partnerScope);

  // Live mode: the "Recent activity" feed comes from the canonical activity_log
  // (real timestamps), RLS-scoped. Mock mode keeps the deterministic derived feed.
  const [liveFeed, setLiveFeed] = useState<ActivityFeedItem[] | null>(null);
  useEffect(() => {
    if (!SUPABASE_ENABLED) return;
    let cancelled = false;
    setLiveFeed(null); // show a loading state, never a stale/false-empty feed
    getActivityFeed({ role, scope: partnerScope }).then((f) => { if (!cancelled) setLiveFeed(f); }).catch(() => { if (!cancelled) setLiveFeed([]); });
    return () => { cancelled = true; };
  }, [role, partnerScope, refreshTick]);

  const feedLoading = SUPABASE_ENABLED && liveFeed === null;
  const feedRows: FeedRow[] = SUPABASE_ENABLED
    ? (liveFeed ?? []).map((f) => ({ id: f.id, ref: f.ref, dot: feedDot(f.kind), text: feedText(f.kind, f.tenant), meta: `${f.ref} · ${f.branch} · ${dmyTime(f.at)}` }))
    : getActivity({ role, scope: partnerScope }).map((a) => ({ id: a.id, ref: a.ref, dot: KIND_DOT[a.kind], text: activityText(a.kind, a.tenant), meta: `${a.ref} · ${a.branch} · ${dmy(a.at)}` }));

  // Feed pagination. Reset to page 1 when the scope changes.
  const [feedPage, setFeedPage] = useState(1);
  useEffect(() => {
    setFeedPage(1);
  }, [role, partnerScope]);
  const feedPageCount = Math.max(1, Math.ceil(feedRows.length / FEED_PAGE_SIZE));
  const safeFeedPage = Math.min(feedPage, feedPageCount);
  const pagedFeed = feedRows.slice((safeFeedPage - 1) * FEED_PAGE_SIZE, safeFeedPage * FEED_PAGE_SIZE);

  // opndoor admin: run the expiry-reminder job now (test mode) and refresh.
  async function runReminders() {
    setRunning(true);
    const r = await runExpiryReminders({});
    if (r.ok) {
      try { const { data } = await sb().auth.getUser(); if (data.user) await hydrateFromSupabase(data.user.id); } catch { /* ignore */ }
      forceRefresh((n) => n + 1);
      toast(`Expiry reminders (test) for ${r.date}: ${r.fired ?? 0} fired${r.emailed ? `, ${r.emailed} emailed` : ''}${r.emailFailed ? `, ${r.emailFailed} email(s) failed - see admin activity log` : ''}.`);
    } else {
      toast(r.error || 'Could not run the expiry reminders.');
    }
    setRunning(false);
  }

  const counts = {
    soon: expiries.filter((e) => e.band === 'soon').length,
    warn: expiries.filter((e) => e.band === 'warn').length,
    notice: expiries.filter((e) => e.band === 'notice').length,
  };

  return (
    <>
      <div className="page-head">
        <div>
          <Eyebrow>Tracking</Eyebrow>
          <h1 className="page-head__title" style={{ marginTop: 10 }}>Activity</h1>
          <p className="page-head__sub">Everything happening across your scope, and the guarantees approaching expiry. Referrals, payments and deeds appear here as they happen.</p>
        </div>
      </div>

      {/* UPCOMING EXPIRIES (the prominent part) */}
      <Card style={{ marginBottom: 18 }}>
        <CardHead
          title="Upcoming expiries"
          sub="Guarantees approaching expiry in your scope, soonest first."
          actions={
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div className="exp-summary">
                <span className="exp-chip exp-chip--soon"><span className="exp-chip__n">{counts.soon}</span><span className="exp-chip__l">within 7 days</span></span>
                <span className="exp-chip exp-chip--warn"><span className="exp-chip__n">{counts.warn}</span><span className="exp-chip__l">within 14 days</span></span>
                <span className="exp-chip exp-chip--notice"><span className="exp-chip__n">{counts.notice}</span><span className="exp-chip__l">within 30 days</span></span>
              </div>
              {SUPABASE_ENABLED && role === 'superadmin' && (
                <Button variant="ghost" size="sm" onClick={runReminders} disabled={running} title="Run the daily expiry-reminder job now in test mode, against today's expiring guarantees">
                  <Icon name="bell" /> {running ? 'Running…' : 'Run reminders (test)'}
                </Button>
              )}
            </div>
          }
        />
        <CardBody style={{ paddingTop: 6, paddingBottom: 6 }}>
          {expiries.length === 0 ? (
            <div className="act-empty">No guarantees are approaching expiry in your scope.</div>
          ) : (
            expiries.map((e) => (
              <div className="exp-row" key={e.ref}>
                <span className={`exp-row__ic exp-row__ic--${e.band}`}><Icon name="calendar" /></span>
                <div className="exp-row__main">
                  <div className="exp-row__ref">{e.ref}</div>
                  <div className="exp-row__sub">{e.prop} · {e.branch} · {e.agency}</div>
                </div>
                <div className="exp-row__date">
                  <div className="lbl">Expires</div>
                  <div className="val">{dmy(e.expiry)}</div>
                </div>
                <div className="exp-row__reminders" title={e.remindersSent > 0 ? `${e.remindersSent} expiry reminder${e.remindersSent === 1 ? '' : 's'} sent` : 'No expiry reminders sent yet'}>
                  <Icon name="bell" strokeWidth={1.9} />
                  <span>{e.remindersSent > 0 ? `${e.remindersSent} sent` : 'None sent'}</span>
                </div>
                <div className="exp-row__pill"><Pill variant={BAND_PILL[e.band]}>{untilText(e.daysUntil)}</Pill></div>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      {/* AWAITING TENANT SIGNATURE (deeds sent, unsigned > 7 days) */}
      {awaitingSig.length > 0 && (
        <Card style={{ marginBottom: 18 }}>
          <CardHead
            title="Awaiting tenant signature"
            sub="Deeds sent for e-signature and still unsigned after more than 7 days, longest waiting first."
            actions={<span className="exp-chip exp-chip--soon"><span className="exp-chip__n">{awaitingSig.length}</span><span className="exp-chip__l">to chase</span></span>}
          />
          <CardBody style={{ paddingTop: 6, paddingBottom: 6 }}>
            {awaitingSig.map((s) => (
              <Link className="exp-row" style={{ textDecoration: 'none', color: 'inherit' }} to={`/applications/${encodeURIComponent(s.ref)}`} key={s.ref}>
                <span className="exp-row__ic exp-row__ic--soon"><Icon name="clock" /></span>
                <div className="exp-row__main">
                  <div className="exp-row__ref">{s.ref}</div>
                  <div className="exp-row__sub">{s.branch} · {s.agency}</div>
                </div>
                <div className="exp-row__date">
                  <div className="lbl">Sent</div>
                  <div className="val">{dmy(s.sentAt)}</div>
                </div>
                <div className="exp-row__date">
                  <div className="lbl">Viewed</div>
                  <div className="val">{s.viewedAt ? dmy(s.viewedAt) : 'Not viewed'}</div>
                </div>
                <div className="exp-row__pill"><Pill variant={s.viewedAt ? 'warn' : 'danger'}>{s.days} days waiting</Pill></div>
              </Link>
            ))}
          </CardBody>
        </Card>
      )}

      {/* ACTIVITY FEED */}
      <Card>
        <CardHead title="Recent activity" sub="Referrals sent, fees paid and deeds issued, most recent first." />
        <CardBody style={{ paddingTop: 8, paddingBottom: 8 }}>
          {feedLoading ? (
            <div className="act-empty">Loading activity…</div>
          ) : feedRows.length === 0 ? (
            <div className="act-empty">No activity yet in your scope.</div>
          ) : (
            pagedFeed.map((a) => (
              <Link className="act-item" to={`/applications/${encodeURIComponent(a.ref)}`} key={a.id}>
                <span className="act-item__dot" style={{ background: a.dot }} />
                <div>
                  <div className="act-item__t">{a.text}</div>
                  <div className="act-item__meta">{a.meta}</div>
                </div>
              </Link>
            ))
          )}
          {!feedLoading && <Pager page={safeFeedPage} pageSize={FEED_PAGE_SIZE} total={feedRows.length} onPage={setFeedPage} noun="events" />}
        </CardBody>
      </Card>
    </>
  );
}
