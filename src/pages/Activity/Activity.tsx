/* =====================================================================
   Activity — a consolidated activity feed plus the upcoming-expiries view,
   both scoped by role and partner. Reached from the "View all activity" link
   in the notifications popover.

   Upcoming expiries is a read-only view of what is lapsing soon. The proactive
   reminders (30/14/7/daily) are a scheduled back-end job; see the INTEGRATION
   note in activityService.getUpcomingExpiries. This page does not fake them.
   ===================================================================== */
import { Link } from 'react-router-dom';
import { getActivity, getAwaitingSignature, getUpcomingExpiries, type ActivityKind, type ExpiryBand } from '@/data';
import { useSession } from '@/session/SessionContext';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Card, CardBody, CardHead } from '@/components/ui/Card';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Icon } from '@/components/ui/Icon';
import { Pill, type PillVariant } from '@/components/ui/Pill';
import './Activity.css';

const dmy = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

const KIND_DOT: Record<ActivityKind, string> = { sent: 'var(--sent)', paid: 'var(--paid)', deed: 'var(--deed)' };
const BAND_PILL: Record<ExpiryBand, PillVariant> = { soon: 'danger', warn: 'warn', notice: 'sent', later: 'muted' };

function activityText(kind: ActivityKind, tenant: string) {
  if (kind === 'paid') return <>Guarantor fee paid for <b>{tenant}</b></>;
  if (kind === 'deed') return <>Deed of Guarantee issued for <b>{tenant}</b></>;
  return <>Referral sent for <b>{tenant}</b></>;
}
function untilText(daysUntil: number): string {
  if (daysUntil <= 0) return 'expires today';
  if (daysUntil === 1) return 'expires tomorrow';
  return `expires in ${daysUntil} days`;
}

export function Activity() {
  usePageMeta('activity', 'Activity', ['Home', 'Activity']);
  const { role, partnerScope } = useSession();

  const feed = getActivity({ role, scope: partnerScope });
  const expiries = getUpcomingExpiries({ role, scope: partnerScope });
  const awaitingSig = getAwaitingSignature(role, partnerScope);

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
            <div className="exp-summary">
              <span className="exp-chip exp-chip--soon"><span className="exp-chip__n">{counts.soon}</span><span className="exp-chip__l">within 7 days</span></span>
              <span className="exp-chip exp-chip--warn"><span className="exp-chip__n">{counts.warn}</span><span className="exp-chip__l">within 14 days</span></span>
              <span className="exp-chip exp-chip--notice"><span className="exp-chip__n">{counts.notice}</span><span className="exp-chip__l">within 30 days</span></span>
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
          {feed.length === 0 ? (
            <div className="act-empty">No activity yet in your scope.</div>
          ) : (
            feed.map((a) => (
              <Link className="act-item" to={`/applications/${encodeURIComponent(a.ref)}`} key={a.id}>
                <span className="act-item__dot" style={{ background: KIND_DOT[a.kind] }} />
                <div>
                  <div className="act-item__t">{activityText(a.kind, a.tenant)}</div>
                  <div className="act-item__meta">{a.ref} · {a.branch} · {dmy(a.at)}</div>
                </div>
              </Link>
            ))
          )}
        </CardBody>
      </Card>
    </>
  );
}
