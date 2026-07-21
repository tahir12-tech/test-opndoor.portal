/* =====================================================================
   Application detail — the full record for one application, data-driven by
   the :ref route param. Status timeline, tenant / property / agent /
   tenancy, guarantee summary, stored deed, activity feed, and the amend
   tenancy-start modal (opndoor admin + Management), which accepts any valid
   date and reissues the deed.

   In live mode payment/deed state comes from getPaymentInfo (the activity_log
   and application row); amends persist via the amend-tenancy-start Edge Function
   (deed reissue applied server-side); payment and deed generation run on Stripe
   and PandaDoc. Send-deed emails the agent contact resolved by orgService.
   ===================================================================== */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { addApplicationNote, addContact, amendTenancyStart, amendTenancyStartDb, canAmendTenancyStart, canSendDeed, canWithdraw, contactForApplication, deedDownloadUrl, effectiveContacts, getApplicationDetail, getApplicationNotes, getPaymentInfo, pandadocSandbox, resendDeed, resendPaymentEmail, sendDeedToAgent, stripeTestMode, withdrawApplication, type AppNote, type PaymentInfo, type WithdrawReason } from '@/data';
import { useSession } from '@/session/SessionContext';
import { SUPABASE_ENABLED } from '@/lib/supabase';
import { isTenancyStartInAllowedRange,parseFlexibleDate } from '@/lib/validation';
import { titleCaseAddress, formatLondonDate, formatLondonDateTime } from '@/lib/format';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Card, CardBody, CardHead } from '@/components/ui/Card';
// import { shouldShowAwaitingTenantSignature } from './deedStatus';
import { Modal } from '@/components/ui/Modal';
import { Pill, type PillVariant } from '@/components/ui/Pill';
import { StatusTimeline } from '@/components/ui/StatusTimeline';
import { useToast } from '@/components/ui/Toast';
import './ApplicationDetail.css';



const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const NOW = new Date(2026, 5, 26);

const fmtLong = (x: Date) => `${x.getDate()} ${MONTHS_LONG[x.getMonth()]} ${x.getFullYear()}`;
const fmtShort = (x: Date) => `${String(x.getDate()).padStart(2, '0')} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
const fmtInput = (x: Date) => formatLondonDate(x);
// Canonical activity timestamp: dd/mm/yyyy · HH:mm (Europe/London).
const fmtStamp = (x: Date) => formatLondonDateTime(x).replace(' - ', ' · ');
// #103 Accept dd/mm/yyyy as before, plus pasted ISO and month-name formats.
const parseInput = (s: string): Date | null => parseFlexibleDate(s);

interface Activity {
  color: string;
  text: React.ReactNode;
  time: string;
}

// Feed dot colour per activity_log event kind.
const feedColor = (kind: string): string => {
  if (kind === 'payment_received') return 'var(--paid)';
  if (kind === 'deed_reminder_failed') return 'var(--warn, #c77d0a)';
  if (kind === 'refunded' || kind === 'deed_error' || kind === 'payment_email_failed' || kind === 'payment_anomaly') return 'var(--danger, #d64545)';
  if (kind === 'withdrawn') return 'var(--ink-mute, #7a7a8c)';
  if (kind === 'expiry_reminder') return 'var(--warn, #c77d0a)';
  if (kind === 'deed_issued' || kind === 'deed_signed' || kind === 'deed_reissued') return 'var(--deed)';
  if (kind === 'referral_created' || kind === 'payment_email_sent' || kind === 'deed_viewed' || kind === 'deed_archived') return 'var(--sent)';
  return 'var(--heliotrope)';
};
// One partner-safe label per business event type. opndoor admins see the raw
// message instead; kinds not listed (e.g. payment_received, refunded) fall back
// to their stored message, which already carries the amount and is partner-safe.
const BUSINESS_LABEL: Record<string, string> = {
  referral_created: 'Referral created and sent to the tenant',
  payment_email_sent: 'Payment email sent to the tenant',
  payment_email_resent: 'Payment email resent to the tenant',
  // Safety net: if a failure ever surfaces business-visible, partners see this
  // clean copy, never the raw provider error (which stays opndoor-admin-only).
  payment_email_failed: 'Payment email could not be sent; opndoor has been notified',
  deed_sent: 'Deed of Guarantee sent to the tenant for signature',
  deed_delivered: 'Deed of Guarantee delivered to the agent',
  deed_undelivered: 'Deed issued; no agent contact on file, not sent',
  deed_viewed: 'Deed viewed by the tenant',
  deed_signed: 'Deed signed by the tenant',
  deed_reminded: 'Signature reminder sent to the tenant',
  deed_resent: 'Deed re-sent to the tenant',
  deed_voided: 'Outstanding deed voided (superseded)',
  deed_regenerated: 'Deed regenerated and sent to the tenant',
  deed_declined: 'Tenant declined to sign; opndoor is reviewing',
  deed_issued: 'Deed of Guarantee issued',
  // tenancy_amended intentionally omitted: its message carries the partner-safe
  // old -> new detail, which should show to every viewer (not be genericised).
  deed_archived: 'Signed deed archived before amendment',
  deed_reissued: 'Deed reissued for signing',
  // #2 'withdrawn' intentionally omitted: its stored message carries the
  // partner-safe reason, which should show verbatim to every viewer.
};

// #2 Withdrawal reasons, in the order shown in the picker.
const WITHDRAW_REASONS: { value: WithdrawReason; label: string }[] = [
  { value: 'another_guarantor', label: 'Tenant found another guarantor' },
  { value: 'tenancy_fell_through', label: 'Tenancy fell through' },
  { value: 'duplicate', label: 'Duplicate referral' },
  { value: 'other', label: 'Other (add a note)' },
];
const REASON_LABEL: Record<WithdrawReason, string> = {
  another_guarantor: 'tenant found another guarantor',
  tenancy_fell_through: 'tenancy fell through',
  duplicate: 'duplicate referral',
  other: 'other',
};

export function ApplicationDetail() {
  const { ref } = useParams();
  const { role, refresh, dataVersion } = useSession();
  const toast = useToast();
  // #10 dataVersion is a memo dep so `d` recomputes after a mutation + refresh()
  // re-hydrates the working copies — the single source of truth for every surface.
  const d = useMemo(() => getApplicationDetail(ref ?? null), [ref, dataVersion]);
  usePageMeta('applications', 'Application detail', ['Home', 'Applications', d.ref]);

  const [currentStart, setCurrentStart] = useState<Date>(d.tenancyStartDate);
  const [deedVersion, setDeedVersion] = useState(1);
  const [amendedDates, setAmendedDates] = useState<{ issue: string; expiry: string } | null>(null);
  const [extraActivity, setExtraActivity] = useState<Activity[]>([]);
  const [showAllActivity, setShowAllActivity] = useState(false); // #113 cap Activity feed at 6
  const [amendOpen, setAmendOpen] = useState(false);
  const [confirmReissueOpen, setConfirmReissueOpen] = useState(false); // #82 signed-deed consequence confirm
  const [amendInput, setAmendInput] = useState('');

  // send-deed-to-agent
  const [sendOpen, setSendOpen] = useState(false);
  const [sendSel, setSendSel] = useState('other'); // '0','1',… (a saved contact) or 'other'
  const [soName, setSoName] = useState('');
  const [soRole, setSoRole] = useState('');
  const [soEmail, setSoEmail] = useState('');
  const [soSave, setSoSave] = useState(false);

  // payment (Stripe, real mode)
  const [searchParams] = useSearchParams();
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deedBusy, setDeedBusy] = useState(false);
  // #2 Withdraw (Sent, pre-payment only)
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [wReason, setWReason] = useState<WithdrawReason | ''>('');
  const [wNote, setWNote] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  // #8 Operational notes (internal-only): admin + management + the owning referrer.
  const maySeeNotes = role === 'superadmin' || role === 'management' || (role === 'referrer' && d.owner === 1);
  const [notes, setNotes] = useState<AppNote[]>([]);
  const [noteBody, setNoteBody] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);

  const loadPayment = useCallback(async () => {
    if (!SUPABASE_ENABLED) return null;
    const info = await getPaymentInfo(d.ref);
    setPaymentInfo(info);
    return info;
  }, [d.ref]);

  useEffect(() => {
    if (!SUPABASE_ENABLED) return;
    let cancelled = false;
    let attempts = 0;
    const justPaid = searchParams.get('paid') === '1';
    const tick = async () => {
      const info = await loadPayment();
      if (cancelled) return;
      // On return from Stripe the webhook may lag a moment; poll briefly until Paid.
      if (justPaid && info && info.paymentState !== 'paid' && info.status === 'sent' && attempts < 5) {
        attempts += 1;
        setTimeout(tick, 2000);
      }
    };
    void tick();
    return () => { cancelled = true; };
  }, [loadPayment, searchParams]);

  // #8 Load the operational notes for the record, when the viewer may see them.
  const loadNotes = useCallback(async () => {
    if (!maySeeNotes) { setNotes([]); return; }
    setNotes(await getApplicationNotes(d.ref));
  }, [d.ref, maySeeNotes]);

  useEffect(() => { void loadNotes(); }, [loadNotes]);

  const doAddNote = async () => {
    const body = noteBody.trim();
    if (!body) return;
    setNoteBusy(true);
    try {
      await addApplicationNote(d.ref, body);
      setNoteBody('');
      await loadNotes();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add the note.');
    } finally {
      setNoteBusy(false);
    }
  };

  const copyLink = async () => {
    if (!paymentInfo?.paymentUrl) return;
    try {
      await navigator.clipboard.writeText(paymentInfo.paymentUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast('Payment link copied.');
    } catch {
      toast('Could not copy the link.');
    }
  };

  const doResend = async () => {
    setResendBusy(true);
    const r = await resendPaymentEmail(d.ref);
    setResendBusy(false);
    // Partner-safe confirmation; the test-mode redirect detail is opndoor-admin-only.
    if (r.ok) { toast(role === 'superadmin' ? 'Payment email resent (test mode) to the review address.' : 'Payment email resent to the tenant.'); void loadPayment(); }
    else toast(r.error || 'Could not resend the email.');
  };

  const doResendDeed = async () => {
    setDeedBusy(true);
    const r = await resendDeed(d.ref);
    setDeedBusy(false);
    if (r.ok) { toast(r.message || 'Reminder sent to the tenant.'); void loadPayment(); }
    else toast(r.error || 'Could not send the deed.');
  };

  const doWithdraw = async () => {
    if (!wReason) return;
    if (wReason === 'other' && !wNote.trim()) { toast('Please add a note explaining the reason.'); return; }
    setWithdrawBusy(true);
    try {
      await withdrawApplication(d.ref, wReason, wNote);
      const note = wNote.trim();
      setWithdrawOpen(false);
      // #10 Single source of truth: re-hydrate the working copies (which bumps
      // dataVersion), so `d`, the list row, the Sent chip and the dashboard counter
      // all recompute to Withdrawn together. In live mode the server activity_log
      // already carries the withdrawal entry (loadPayment pulls it in); the optimistic
      // feed row is MOCK-ONLY, avoiding the ghost/duplicate with the wrong date+actor.
      if (!SUPABASE_ENABLED) {
        setExtraActivity((prev) => [
          { color: 'var(--ink-mute, #7a7a8c)', text: `Application withdrawn (${REASON_LABEL[wReason]})${note ? `: ${note}` : ''}.`, time: `${fmtShort(NOW)} · You` },
          ...prev,
        ]);
      }
      toast('Application withdrawn.');
      await refresh();
      void loadPayment();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not withdraw the application.');
    } finally {
      setWithdrawBusy(false);
    }
  };


  const doDownloadDeed = async () => {
    if (!SUPABASE_ENABLED) return;
    const r = await deedDownloadUrl(d.ref);
    if (r.ok && r.url) window.open(r.url, '_blank', 'noopener');
    else toast(r.error || 'Could not open the deed.');
  };

  // #105 Withdrawn/Expired are terminal pre-payment exits: only Sent was reached,
  // and the timeline must render the termination, never a false Paid/Deed tick.
  const timelineTerminated = d.status === 'withdrawn' || d.status === 'expired';
  const reached = timelineTerminated ? 1 : d.status === 'sent' ? 1 : d.status === 'paid' ? 2 : 3;
  // Third-node caption: on completion it states the outcome; while awaiting it
  // surfaces the deed's signing journey (sent / viewed / not yet viewed). The
  // three milestones themselves are unchanged.
  let deedDate = d.deedStr || 'Awaiting deed';
  let deedNote = d.deedStr ? 'Guarantee deed issued and stored' : 'Deed not yet issued';
  if (d.status === 'deed') {
    deedNote = 'Signed by tenant and issued';
  } else if (paymentInfo?.deedState === 'awaiting_tenant') {
    deedDate = 'Awaiting signature';
    deedNote = paymentInfo.deedViewedAt
      ? `Awaiting tenant signature · viewed ${fmtStamp(new Date(paymentInfo.deedViewedAt))}`
      : `Sent ${paymentInfo.deedSentAt ? fmtStamp(new Date(paymentInfo.deedSentAt)) : ''}, not yet viewed`;
  }
  // #105 On a terminal pre-payment exit the second node shows the termination
  // (greyed via the timeline's 'terminated' state), not "Awaiting payment".
  const paidStep = timelineTerminated
    ? { label: 'Paid', date: d.status === 'withdrawn' ? 'Withdrawn' : 'Expired', note: d.status === 'withdrawn' ? 'Withdrawn before payment' : 'Expired, unpaid after 14 days' }
    : { label: 'Paid', date: d.paidStr || 'Awaiting payment', note: d.paidStr ? `Guarantor fee paid · ${d.rent}` : 'Guarantor fee not yet paid' };
  const steps = [
    { label: 'Sent', date: d.sentStr, note: `Referral sent to tenant by ${d.referrer}` },
    paidStep,
    { label: 'Deed Issued', date: deedDate, note: deedNote },
  ];

  const isDeed = d.status === 'deed';
  const deedName = `Guarantee_Deed_${d.ref}${deedVersion > 1 ? `_v${deedVersion}` : ''}.pdf`;
  const deedMeta = deedVersion > 1 ? `PDF · 248 KB · reissued ${fmtShort(NOW)}` : `PDF · 248 KB · issued ${d.issue}`;
  const gsumIssue = isDeed ? amendedDates?.issue ?? d.issue : 'Pending';
  const gsumExpiry = isDeed ? amendedDates?.expiry ?? d.expiry : 'Pending';
  const gsumNote = isDeed ? 'Auto-assigned by the system' : 'Reserved · confirmed once the deed is issued';

  // ---- Activity feed ----
  // Real mode: one canonical feed sourced solely from the activity_log, with a
  // real timestamp on every row, audience-filtered (raw technical failures are
  // opndoor-admin-only), one label per event type, one format (dd/mm/yyyy · HH:mm),
  // strictly chronological. The status timeline strip above is separate and stays.
  // Mock/demo mode: the deterministic timeline-derived feed, unchanged.
  const isAdmin = role === 'superadmin';
  let activity: Activity[];
  if (SUPABASE_ENABLED && paymentInfo) {
    const log = paymentInfo.log;
    const visible = isAdmin ? log : log.filter((l) => l.visibility !== 'internal');
    const rows = visible.map((l) => ({
      at: new Date(l.at),
      color: feedColor(l.kind),
      text: (isAdmin ? l.message : BUSINESS_LABEL[l.kind] ?? l.message) as React.ReactNode,
      actor: l.actor ?? 'System',
    }));
    // Partner-safe soft entry when the deed is currently stuck (raw error hidden).
    if (!isAdmin && paymentInfo.deedState === 'error') {
      const lastErr = log.find((l) => l.visibility === 'internal'); // log is newest-first
      rows.push({
        at: lastErr ? new Date(lastErr.at) : new Date(),
        color: 'var(--warn, #c77d0a)',
        text: 'Deed delivery delayed, opndoor has been notified',
        actor: 'System',
      });
    }
    rows.sort((a, b) => b.at.getTime() - a.at.getTime());
    activity = [...extraActivity, ...rows.map((r) => ({ color: r.color, text: r.text, time: `${fmtStamp(r.at)} · ${r.actor}` }))];
  } else {
    const baseActivity: Activity[] = [];
    if (d.deedStr) baseActivity.push({ color: 'var(--deed)', text: 'Deed issued and stored against the record', time: `${d.deedStr} · System` });
    if (d.paidStr) baseActivity.push({ color: 'var(--paid)', text: 'Guarantor fee paid by tenant', time: `${d.paidStr} · System` });
    baseActivity.push({ color: 'var(--sent)', text: 'Application sent to tenant', time: `${d.sentStr} · ${d.referrer}` });
    activity = [...extraActivity, ...baseActivity];
  }

  // ---- payment display (Stripe, real mode) ----
  const pi = paymentInfo;
  // ---- #2/#13 terminal (withdrawn / expired) state — single source of truth is
  // d.status, which the memo recomputes after refresh() (no optimistic shadow). ----
  const owned = d.owner === 1;
  const isWithdrawn = d.status === 'withdrawn';
  const isExpired = d.status === 'expired';
  const isTerminal = isWithdrawn || isExpired;
  const withdrawnReason = d.withdrawnReason;
  // A withdrawn/expired application collects no payment: neither Paid nor Awaiting.
  const payWithdrawn = pi?.status === 'withdrawn' || pi?.status === 'expired' || isTerminal;
  const payRefunded = pi?.paymentState === 'refunded';
  const payPaid = !!pi && !payRefunded && !payWithdrawn && (pi.paymentState === 'paid' || (pi.status !== 'sent' && pi.status !== 'withdrawn' && pi.status !== 'expired'));
  const payAwaiting = !!pi && !payPaid && !payRefunded && !payWithdrawn;
  // #94 The card status line must tier like the feed: non-admins never see the
  // internal "Redirected to ... (test mode)" row (filtered here), and the business
  // message (which names the actor) is rendered as its partner-safe label below.
  const lastEmailLog = (isAdmin ? pi?.log : pi?.log?.filter((l) => l.visibility !== 'internal'))?.find((l) => l.kind.startsWith('payment_email'));

  // Withdraw is offered only at Sent, before payment, to the owner / management / admin.
  const showWithdraw = canWithdraw(role, d.status, owned) && !isTerminal;
  const pillVariant: PillVariant = d.status === 'withdrawn' || d.status === 'expired' ? 'muted' : d.status;
  const statusLabel = d.statusLabel;

  // ---- amend permission + context ----
  const PAYMENT = d.paymentDate;
  // Before payment (Sent) amending just corrects data; after payment it reissues the deed.
  const reissues = d.status !== 'sent';
  // #82 Amending a SIGNED (executed) deed is destructive: void + reissue + agent
  // re-notification. It needs an explicit consequence confirmation before saving.
  const executed = d.status === 'deed' || paymentInfo?.deedState === 'executed';
  // Who may amend: Sent -> any viewing role (Referrer only their own); Paid/Deed -> Management + opndoor admin.
  // A withdrawn or expired application is terminal: no amend (or other action) offered.
  const canAmend = !isTerminal && canAmendTenancyStart(role, d.status, owned, paymentInfo?.deedState ?? null);

  // ---- amend validation ----
  // Any valid calendar date is allowed. We only require a real dd/mm/yyyy date
  // that differs from the current start; there is no payment-window restriction.


  //our code update
  const parsed = parseInput(amendInput);
  let amendTone: 'ok' | 'err' | 'neutral' = 'err';
  let amendText = 'Enter a valid date as dd/mm/yyyy';
  let canSave = false;
  if (!amendInput.trim()) {
    amendTone = 'err';
    amendText = 'Enter a valid date as dd/mm/yyyy';
  } else if (parsed) {
    if (parsed.getTime() === currentStart.getTime()) {
      amendTone = 'neutral';
      amendText = 'This is the current start date';
    } else if (!isTenancyStartInAllowedRange(parsed)) {
      amendTone = 'err';
      amendText = 'Date must be within 7 days in the past and 2 years in the future';
    } else {
      amendTone = 'ok';
      amendText = executed
        ? 'Valid. The signed deed will be voided and a corrected deed reissued to the tenant to sign.'
        : reissues ? 'Valid. A new deed will be issued with this date.' : 'Valid. The tenancy start date will be updated.';
      canSave = true;
    }
  }

  //Old code
  // const parsed = parseInput(amendInput);
  // let amendTone: 'ok' | 'err' | 'neutral' = 'err';
  // let amendText = 'Enter a valid date as dd/mm/yyyy';
  // let canSave = false;
  // if (parsed) {
  //   if (parsed.getTime() === currentStart.getTime()) {
  //     amendTone = 'neutral';
  //     amendText = 'This is the current start date';
  //   }
  //   //our code updated
  //   else if (!isTenancyStartInAllowedRange(parsed)) {
  //     amendTone = 'err';
  //     amendText = 'Date must be within 7 days in the past and 2 years in the future';
  //   }  
  //   else {
  //     amendTone = 'ok';
  //     amendText = executed
  //       ? 'Valid. The signed deed will be voided and a corrected deed reissued to the tenant to sign.'
  //       : reissues ? 'Valid. A new deed will be issued with this date.' : 'Valid. The tenancy start date will be updated.';
  //     canSave = true;
  //   }
  // }

  function openAmend() {
    setAmendInput(fmtInput(currentStart));
    setAmendOpen(true);
  }



  //our code update
 async function saveAmend(confirmReissue = false) {
    const parsedDate = parseInput(amendInput);
    if (!parsedDate || parsedDate.getTime() === currentStart.getTime() || !isTenancyStartInAllowedRange(parsedDate)) {
      toast('Enter a valid tenancy start date within 7 days in the past and 2 years in the future.');
      return;
    }
    // #82 On a signed deed, require the explicit consequence confirmation first.
    if (executed && !confirmReissue) { setConfirmReissueOpen(true); return; }
    let serverMsg: string | undefined;
    try {
      serverMsg = await amendTenancyStartDb(d.ref, parsedDate, confirmReissue);
    } catch (err) {
      // Defence in depth: if the server still asks for confirmation, prompt for it.
      if (err && typeof err === 'object' && (err as { needsConfirm?: boolean }).needsConfirm) { setConfirmReissueOpen(true); return; }
      toast(err instanceof Error ? err.message : 'Could not amend the tenancy start date.');
      return;
    }
    setConfirmReissueOpen(false);
    const result = amendTenancyStart(d.status, parsedDate);
    setCurrentStart(parsedDate);
    if (result.reissued) {
      setDeedVersion((v) => v + 1);
      if (isDeed && result.issue && result.expiry) setAmendedDates({ issue: fmtShort(result.issue), expiry: fmtShort(result.expiry) });
    }
    // Mock/demo mode only: an optimistic feed entry. In live mode the activity
    // feed is sourced solely from the server activity_log (one entry per amend,
    // written by the Edge Function) and refreshed by loadPayment below, so a
    // client-side entry here would double-log and could claim a phantom reissue.
    if (!SUPABASE_ENABLED) {
      const who = role === 'superadmin' ? 'opndoor' : role === 'management' ? 'Management' : 'Referrer'; // #112
      setExtraActivity((prev) => [
        {
          color: 'var(--heliotrope)',
          text: result.reissued ? <>Tenancy start amended to <b>{fmtLong(parsedDate)}</b>; deed reissued</> : <>Tenancy start amended to <b>{fmtLong(parsedDate)}</b></>,
          time: `${fmtShort(NOW)} · ${who}`,
        },
        ...prev,
      ]);
    }
    setAmendOpen(false);
    // The Edge Function's summary reflects what actually happened to the deed
    // (voided+regenerated, or archived+replaced); prefer it in live mode.
    if (serverMsg) toast(serverMsg);
    else toast(result.reissued ? `Tenancy start updated to ${fmtLong(parsedDate)}. New deed of guarantee issued.` : `Tenancy start updated to ${fmtLong(parsedDate)}.`);
    void loadPayment();
  }



  //old code

  // async function saveAmend(confirmReissue = false) {
  //   if (!parsed || !canSave) return;
  //   // #82 On a signed deed, require the explicit consequence confirmation first.
  //   if (executed && !confirmReissue) { setConfirmReissueOpen(true); return; }
  //   let serverMsg: string | undefined;
  //   try {
  //     serverMsg = await amendTenancyStartDb(d.ref, parsed, confirmReissue);
  //   } catch (err) {
  //     // Defence in depth: if the server still asks for confirmation, prompt for it.
  //     if (err && typeof err === 'object' && (err as { needsConfirm?: boolean }).needsConfirm) { setConfirmReissueOpen(true); return; }
  //     toast(err instanceof Error ? err.message : 'Could not amend the tenancy start date.');
  //     return;
  //   }
  //   setConfirmReissueOpen(false);
  //   const result = amendTenancyStart(d.status, parsed);
  //   setCurrentStart(parsed);
  //   if (result.reissued) {
  //     setDeedVersion((v) => v + 1);
  //     if (isDeed && result.issue && result.expiry) setAmendedDates({ issue: fmtShort(result.issue), expiry: fmtShort(result.expiry) });
  //   }
  //   // Mock/demo mode only: an optimistic feed entry. In live mode the activity
  //   // feed is sourced solely from the server activity_log (one entry per amend,
  //   // written by the Edge Function) and refreshed by loadPayment below, so a
  //   // client-side entry here would double-log and could claim a phantom reissue.
  //   if (!SUPABASE_ENABLED) {
  //     const who = role === 'superadmin' ? 'opndoor' : role === 'management' ? 'Management' : 'Referrer'; // #112
  //     setExtraActivity((prev) => [
  //       {
  //         color: 'var(--heliotrope)',
  //         text: result.reissued ? <>Tenancy start amended to <b>{fmtLong(parsed)}</b>; deed reissued</> : <>Tenancy start amended to <b>{fmtLong(parsed)}</b></>,
  //         time: `${fmtShort(NOW)} · ${who}`,
  //       },
  //       ...prev,
  //     ]);
  //   }
  //   setAmendOpen(false);
  //   // The Edge Function's summary reflects what actually happened to the deed
  //   // (voided+regenerated, or archived+replaced); prefer it in live mode.
  //   if (serverMsg) toast(serverMsg);
  //   else toast(result.reissued ? `Tenancy start updated to ${fmtLong(parsed)}. New deed of guarantee issued.` : `Tenancy start updated to ${fmtLong(parsed)}.`);
  //   void loadPayment();
  // }

  // ---- send deed to agent ----
  // Resolve the branch's effective contacts (agency default when the branch has none).
  const resolved = contactForApplication(d.agency, d.branch);
  const eff = effectiveContacts(resolved.agency, resolved.branch);
  const sendSrc = eff.inherited ? `agency default for ${d.agency}` : `${d.branch} branch`;
  const isReferrer = role === 'referrer';
  // Who may send the issued deed: Referrers only on their own; Management + opndoor admin on any in scope.
  const canSend = canSendDeed(role, d.owner === 1);
  // Referrers are send-only: they can only send when a recipient is already resolved.
  const sendDisabled = isReferrer && !resolved.contact;

  function openSend() {
    setSendSel(eff.list.length ? '0' : 'other');
    setSoName('');
    setSoRole('');
    setSoEmail('');
    setSoSave(false);
    setSendOpen(true);
  }

  async function confirmSend() {
    let c: { name: string; email: string; role: string } | null = null;
    if (isReferrer) {
      // Referrers send only to the resolved recipient: no one-off address, no saving.
      if (resolved.contact) c = { name: resolved.contact.name, email: resolved.contact.email, role: resolved.contact.role };
    } else if (sendSel === 'other') {
      const name = soName.trim();
      const email = soEmail.trim();
      if (!name || !email) return;
      c = { name, email, role: soRole.trim() };
      if (soSave) {
        // save to the branch if it exists in the store, otherwise the agency (matches the prototype)
        const branchName = resolved.branch ? d.branch : null;
        addContact(d.agency, branchName, { name, email, phone: '', role: c.role, primary: false });
      }
    } else {
      const picked = eff.list[+sendSel];
      if (picked) c = { name: picked.name, email: picked.email, role: picked.role };
    }
    if (!c) return;
    try {
      // The database re-checks canSendDeed; Referrers may only send to the resolved contact.
      if (isReferrer) await sendDeedToAgent(d.ref);
      else await sendDeedToAgent(d.ref, c.email, sendSel === 'other' ? soSave : false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the deed.');
      return;
    }
    const who = role === 'superadmin' ? 'opndoor' : role === 'management' ? 'Management' : 'Referrer'; // #112
    setExtraActivity((prev) => [
      { color: 'var(--heliotrope)', text: <>Deed of Guarantee sent to <b>{c!.name}</b> ({c!.email})</>, time: `${SUPABASE_ENABLED ? fmtStamp(new Date()) : fmtShort(NOW)} · ${who}` },
      ...prev,
    ]);
    setSendOpen(false);
    toast(`Deed of Guarantee sent to ${c.name} at ${c.email}.`);
  }

  // Honest not-found: the reference does not exist or is not accessible to this
  // viewer (RLS returned nothing). Never substitute another of their records.
  if (d.notFound) {
    return (
      <>
        <div className="backbar">
          <Link to="/applications"><Icon name="arrowLeft" /> All applications</Link>
        </div>
        <div className="notfound">
          <span className="notfound__ic"><Icon name="alert" strokeWidth={2} /></span>
          <h1 className="notfound__title">Application not found</h1>
          <p className="notfound__sub">
            {ref ? <>We couldn&rsquo;t find <b>{ref}</b>, or it isn&rsquo;t part of your portfolio.</> : <>No application reference was given.</>}
          </p>
          <Button to="/applications" variant="primary"><Icon name="arrowLeft" /> Back to applications</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="backbar">
        <Link to="/applications"><Icon name="arrowLeft" /> All applications</Link>
      </div>

      <div className="rec-head">
        <div className="rec-head__id">
          <span className="rec-head__av">{d.initials}</span>
          <div>
            <div className="rec-head__name">{d.name}</div>
            <div className="rec-head__meta">
              <Pill variant={pillVariant}>{statusLabel}</Pill>
              <span>·</span><span>Reference {d.ref}</span>
              <span>·</span><span>{d.branch} · {d.agency}</span>
              {role !== 'referrer' && d.partnerName && <><span>·</span><span>{d.partnerName}</span></>}
            </div>
          </div>
        </div>
        <div className="rec-head__actions">
          {isDeed && <Button variant="dark" size="sm" onClick={doDownloadDeed}><Icon name="download" /> Download deed</Button>}
          {showWithdraw && <Button variant="ghost" size="sm" onClick={() => { setWReason(''); setWNote(''); setWithdrawOpen(true); }}><Icon name="ban" /> Withdraw</Button>}
        </div>
      </div>

      {isWithdrawn && (
        <div className="rec-withdrawn">
          <Icon name="ban" strokeWidth={2.2} />
          <div>
            <b>This application was withdrawn{withdrawnReason ? ` (${REASON_LABEL[withdrawnReason]})` : ''}.</b>{' '}
            It is excluded from conversion figures and Leagues, and receives no further payment reminders.
          </div>
        </div>
      )}
      {isExpired && (
        <div className="rec-withdrawn">
          <Icon name="clock" strokeWidth={2.2} />
          <div>
            <b>This application expired (guarantor fee unpaid 14 days after referral).</b>{' '}
            It is excluded from conversion figures and Leagues, and receives no further reminders. A late payment automatically reinstates it to Paid.
          </div>
        </div>
      )}

      <Card style={{ marginBottom: 18 }}>
        <CardHead title="Status timeline" sub="Sent to Paid to Deed Issued" />
        <CardBody>
          <StatusTimeline steps={steps} reached={reached} terminated={timelineTerminated} />
        </CardBody>
      </Card>

      <div className="detail-grid">
        {/* LEFT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Card>
            <CardHead title="Tenant details" />
            <CardBody style={{ paddingTop: 6, paddingBottom: 6 }}>
              <div className="drow"><span className="drow__k">Full name</span><span className="drow__v"><b>{d.fullName}</b></span></div>
              <div className="drow"><span className="drow__k">Date of birth</span><span className="drow__v">{d.dob}</span></div>
              <div className="drow"><span className="drow__k">Email</span><span className="drow__v">{d.email}</span></div>
              <div className="drow"><span className="drow__k">Phone</span><span className="drow__v">{d.phone}</span></div>
            </CardBody>
          </Card>

          <Card>
            <CardHead title="Property" />
            <CardBody style={{ paddingTop: 6, paddingBottom: 6 }}>
              <div className="drow"><span className="drow__k">Address line 1</span><span className="drow__v">{titleCaseAddress(d.addr1)}</span></div>
              <div className="drow"><span className="drow__k">Address line 2</span><span className="drow__v">{d.addr2 ? titleCaseAddress(d.addr2) : '—'}</span></div>
              <div className="drow"><span className="drow__k">City / town</span><span className="drow__v">{titleCaseAddress(d.city)}</span></div>
              <div className="drow"><span className="drow__k">County</span><span className="drow__v">{titleCaseAddress(d.county)}</span></div>
              <div className="drow"><span className="drow__k">Postcode</span><span className="drow__v"><b>{d.postcode}</b></span></div>
            </CardBody>
          </Card>

          <Card>
            <CardHead title="Referring agent" sub="Claim contact. The deed is in favour of the property." />
            <CardBody style={{ paddingTop: 6, paddingBottom: 6 }}>
              <div className="drow"><span className="drow__k">Agency</span><span className="drow__v"><b>{d.agency}</b></span></div>
              <div className="drow"><span className="drow__k">Branch</span><span className="drow__v">{d.branch}</span></div>
              {role !== 'referrer' && d.partnerName && <div className="drow"><span className="drow__k">Partner</span><span className="drow__v">{d.partnerName}</span></div>}
              <div className="drow"><span className="drow__k">Address</span><span className="drow__v">{titleCaseAddress(d.agentAddr)}</span></div>
              <div className="drow"><span className="drow__k">Deed in favour of</span><span className="drow__v">{titleCaseAddress(d.addr1)}, {d.postcode}</span></div>
            </CardBody>
          </Card>

          <Card>
            <CardHead
              title="Tenancy"
              actions={
                canAmend && <Button variant="ghost" size="sm" onClick={openAmend}><Icon name="calendar" /> Amend start date</Button>
              }
            />
            <CardBody style={{ paddingTop: 6, paddingBottom: 6 }}>
              <div className="drow"><span className="drow__k">Monthly rent</span><span className="drow__v"><b style={{ fontFamily: 'var(--display)', fontSize: 16 }}>{d.rent}</b> per month</span></div>
              <div className="drow"><span className="drow__k">Tenancy start</span><span className="drow__v">{fmtLong(currentStart)}</span></div>
              <div className="drow"><span className="drow__k">Referrer</span><span className="drow__v">{d.referrerRole === 'superadmin' ? 'opndoor' : d.referrer}</span></div>
            </CardBody>
          </Card>

          {/* #8 Operational notes — internal only (opndoor admin + Management + owning
              Referrer). Append-only; never shared with tenants or agents, never exported. */}
          {maySeeNotes && (
            <Card>
              <CardHead title="Notes" sub="Internal operational notes. Not shared with tenants or agents, and never exported." />
              <CardBody style={{ paddingTop: 8, paddingBottom: 12 }}>
                {notes.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--ink-mute)', padding: '4px 0 10px' }}>No notes yet.</div>
                ) : (
                  notes.map((n) => (
                    <div className="note-item" key={n.id}>
                      <span className="note-item__dot" style={{ background: 'var(--heliotrope)' }} />
                      <div>
                        <div className="note-item__t">{n.body}</div>
                        <div className="note-item__time">{fmtStamp(new Date(n.at))} · {n.author ?? 'System'}</div>
                      </div>
                    </div>
                  ))
                )}
                <div className="field" style={{ marginTop: 12 }}>
                  <label htmlFor="note-body">Add a note</label>
                  <textarea id="note-body" rows={3} placeholder="Operational notes only, no sensitive personal data." value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
                </div>
                <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="primary" size="sm" onClick={() => void doAddNote()} disabled={noteBusy || !noteBody.trim()}><Icon name="plus" /> {noteBusy ? 'Adding…' : 'Add note'}</Button>
                </div>
              </CardBody>
            </Card>
          )}
        </div>

        {/* RIGHT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {SUPABASE_ENABLED && pi && (
            <Card>
              <CardHead title="Payment" actions={stripeTestMode() ? <span className="pay-badge">Test mode</span> : undefined} />
              <CardBody style={{ paddingTop: 6, paddingBottom: 12 }}>
                {payWithdrawn && (
                  <>
                    <div className="pay-state pay-state--refunded"><span className="pay-dot" />{isExpired ? 'Expired' : 'Withdrawn'}</div>
                    <div className="pay-note">{isExpired
                      ? 'This application expired before payment, so no guarantor fee was collected. A late payment automatically reinstates it to Paid.'
                      : 'This application was withdrawn before payment, so no guarantor fee was collected. It is excluded from conversion figures and receives no payment reminders.'}</div>
                  </>
                )}
                {payPaid && (
                  <>
                    <div className="pay-state pay-state--paid"><span className="pay-dot" />Paid</div>
                    <div className="drow"><span className="drow__k">Paid on</span><span className="drow__v">{pi.paidAt ? fmtInput(new Date(pi.paidAt)) : '—'}</span></div>
                    {/* Seeded/test records carry no Stripe data: show the fee from the
                        application (one month's rent) and an honest provenance note
                        rather than a misleading £0 / "—". */}
                    <div className="drow"><span className="drow__k">Amount</span><span className="drow__v"><b>£{(pi.paidAmount ?? d.rentNum).toLocaleString('en-GB')}</b></span></div>
                    <div className="drow"><span className="drow__k">Stripe reference</span><span className="drow__v pay-mono">{pi.paymentRef ?? 'Seeded test record'}</span></div>
                    {pi.paymentRef == null && (
                      <div className="pay-note">Seeded/test record: no Stripe payment reference. The amount shown is the guarantor fee (one month&rsquo;s rent) recorded against the application.</div>
                    )}
                  </>
                )}
                {payRefunded && (
                  <>
                    <div className="pay-state pay-state--refunded"><span className="pay-dot" />Refunded</div>
                    {pi.refundAfterStart && (
                      <div className="pay-anomaly">
                        <Icon name="alert" strokeWidth={2.2} />
                        <span><b>Refunded after tenancy start, outside refund policy.</b> Review required. Recorded truthfully; nothing was reversed automatically.</span>
                      </div>
                    )}
                    <div className="drow"><span className="drow__k">Refunded on</span><span className="drow__v">{pi.refundedAt ? fmtInput(new Date(pi.refundedAt)) : '—'}</span></div>
                    <div className="drow"><span className="drow__k">Refund reference</span><span className="drow__v pay-mono">{pi.refundRef ?? '—'}</span></div>
                    <div className="pay-note">No commission or premium accrues on a refunded fee. The Sent to Paid transition is not reversed (by design).</div>
                  </>
                )}
                {payAwaiting && (
                  <>
                    <div className="pay-state pay-state--awaiting"><span className="pay-dot" />Awaiting payment</div>
                    <div className="drow"><span className="drow__k">Guarantor fee</span><span className="drow__v"><b>{d.rent}</b> · one month's rent</span></div>
                    {pi.paymentUrl && (
                      <>
                        <div className="pay-link">
                          <input readOnly value={pi.paymentUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Checkout link" />
                          <Button variant="ghost" size="sm" onClick={copyLink}>{copied ? 'Copied' : 'Copy'}</Button>
                        </div>
                        <div style={{ marginTop: 10 }}>
                          <Button variant="primary" size="sm" block onClick={doResend} disabled={resendBusy}><Icon name="mail" /> {resendBusy ? 'Sending…' : 'Resend payment email'}</Button>
                        </div>
                      </>
                    )}
                    {lastEmailLog && (
                      <div className={`pay-note${lastEmailLog.kind === 'payment_email_failed' ? ' pay-note--warn' : ''}`}>
                        {lastEmailLog.kind === 'payment_email_failed' && !isAdmin
                          ? 'Payment email could not be sent. Use the copy link above to share it with the tenant; opndoor has been notified.'
                          : isAdmin ? lastEmailLog.message : (BUSINESS_LABEL[lastEmailLog.kind] ?? lastEmailLog.message)}
                      </div>
                    )}
                  </>
                )}
              </CardBody>
            </Card>
          )}
          <Card className="gsum">
            <CardBody>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>Guarantee reference</div>
              <div className="gsum__ref">{d.ref}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 4, marginBottom: 14 }}>{gsumNote}</div>
              <div className="gsum__row"><span className="k">Issue date</span><span className="v">{gsumIssue}</span></div>
              <div className="gsum__row"><span className="k">Expiry date</span><span className="v">{gsumExpiry}</span></div>
              <div className="gsum__row"><span className="k">Guarantee period</span><span className="v">12 months</span></div>
              <div className="gsum__row"><span className="k">Guaranteed annual rent</span><span className="v">{d.annual}</span></div>
            </CardBody>
          </Card>

          <Card>
            <CardHead title="Guarantee deed" actions={SUPABASE_ENABLED && pandadocSandbox() ? <span className="pay-badge">Sandbox</span> : undefined} />
            <CardBody>
              {isDeed ? (
                <>
                  <div className="deed">
                    <span className="deed__ic"><Icon name="file" strokeWidth={1.8} /></span>
                    <div className="grow">
                      <div className="deed__t">{deedName}</div>
                      <div className="deed__s">{deedMeta}</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 14 }}>
                    <Button variant="primary" block onClick={doDownloadDeed}><Icon name="download" /> Download deed</Button>
                  </div>
                  {canSend && (
                    <div style={{ marginTop: 10 }}>
                      <Button variant="ghost" block onClick={openSend}><Icon name="send" /> Send deed to agent</Button>
                    </div>
                  )}
                </>
              )  : SUPABASE_ENABLED && pi && d.status === 'paid' && pi.deedState ? (
  pi.deedState === 'awaiting_tenant' ? (
    <>
      {/* awaiting tenant signature UI */}
    </>
  ) : pi.deedState === 'declined' ? (
    <div className="pay-anomaly">
      <Icon name="alert" strokeWidth={2.2} />
      <span>Tenant declined to sign the deed. Review required.</span>
    </div>
  ) : pi.deedState === 'voided' ? (
    <div className="pay-anomaly">
      <Icon name="alert" strokeWidth={2.2} />
      <span>
        {pi.paymentState === 'refunded'
          ? 'Payment refunded and the associated Deed of Guarantee has been voided.'
          : 'Deed document voided in PandaDoc. Review required.'}
      </span>
    </div>
  ) : (
    <>
      <div className="pay-anomaly">
        <Icon name="alert" strokeWidth={2.2} />
        <span>Deed could not be generated. Check the branch has an agent contact, then retry.</span>
      </div>
      <div style={{ marginTop: 10 }}>
        <Button variant="primary" size="sm" block onClick={doResendDeed} disabled={deedBusy}>
          <Icon name="file" /> {deedBusy ? 'Working…' : 'Generate deed'}
        </Button>
      </div>
    </>
  )
) : (
  <div className="deed" style={{ opacity: 0.85 }}>
    <span className="deed__ic" style={{ color: 'var(--ink-mute)' }}><Icon name="clock" strokeWidth={1.8} /></span>
    <div className="grow">
      <div className="deed__t">Deed not yet issued</div>
      <div className="deed__s">
        {d.status === 'paid' ? 'Deed sent for signature shortly after payment' : 'Issued once the guarantor fee is paid'}
      </div>
    </div>
  </div>)}
            </CardBody>
          </Card>

          <Card>
            <CardHead title="Activity" />
            <CardBody style={{ paddingTop: 8, paddingBottom: 8 }}>
              {(showAllActivity ? activity : activity.slice(0, 6)).map((a, i) => (
                <div className="note-item" key={i}>
                  <span className="note-item__dot" style={{ background: a.color }} />
                  <div>
                    <div className="note-item__t">{a.text}</div>
                    <div className="note-item__time">{a.time}</div>
                  </div>
                </div>
              ))}
              {activity.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAllActivity((v) => !v)}
                  style={{ display: 'block', margin: '4px 0 2px', background: 'none', border: 'none', padding: 0, color: 'var(--heliotrope-deep, #6b3fa0)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}
                >
                  {showAllActivity ? 'Show fewer' : `Show all (${activity.length})`}
                </button>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {/* AMEND MODAL */}
      <Modal
        open={amendOpen}
        onClose={() => setAmendOpen(false)}
        width={460}
        title="Amend tenancy start date"
        sub={reissues ? 'Amending the tenancy start date will reissue the Deed of Guarantee with the new date, and the expiry updates to 12 months on.' : 'Correct the tenancy start date. There is no deed yet, so this just updates the application.'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAmendOpen(false)}>Cancel</Button>
            {/* <Button variant="primary" onClick={() => saveAmend()} disabled={!canSave}>{executed ? 'Review consequences' : reissues ? 'Save and reissue deed' : 'Save start date'}</Button> */}
             <Button variant="primary" onClick={() => saveAmend()} disabled={!canSave || !amendInput.trim()}>{executed ? 'Review consequences' : reissues ? 'Save and reissue deed' : 'Save start date'}</Button>
          </>
        }
      >
        <div className="amend-facts">
          {PAYMENT && <div className="amend-fact"><div className="k">Payment date</div><div className="v">{fmtLong(PAYMENT)}</div></div>}
          <div className="amend-fact"><div className="k">Current start</div><div className="v">{fmtLong(currentStart)}</div></div>
        </div>
        <div className="field">
          <label htmlFor="amend-input">New tenancy start date</label>
          <input id="amend-input" type="text" inputMode="numeric" placeholder="dd/mm/yyyy" autoComplete="off" value={amendInput} onChange={(e) => setAmendInput(e.target.value)} />
        </div>
        <div className={`amend-msg${amendTone === 'ok' ? ' amend-msg--ok' : amendTone === 'err' ? ' amend-msg--err' : ''}`} style={amendTone === 'neutral' ? { color: 'var(--ink-mute)' } : undefined}>
          <Icon name={amendTone === 'err' ? 'info' : 'check'} strokeWidth={2.4} style={amendTone === 'neutral' ? { color: 'var(--ink-mute)' } : amendTone === 'ok' ? { color: 'var(--deed)' } : undefined} />
          {amendText}
        </div>
      </Modal>

      {/* #2 WITHDRAW APPLICATION (Sent, pre-payment only) */}
      <Modal
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        width={460}
        title="Withdraw application"
        sub="Withdrawing marks this referral as closed before payment. It is excluded from conversion figures and Leagues, and receives no further payment reminders. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setWithdrawOpen(false)} disabled={withdrawBusy}>Cancel</Button>
            <Button variant="primary" className="btn--danger" onClick={() => void doWithdraw()} disabled={withdrawBusy || !wReason || (wReason === 'other' && !wNote.trim())}>{withdrawBusy ? 'Withdrawing…' : 'Withdraw application'}</Button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="withdraw-reason">Reason</label>
          <select id="withdraw-reason" value={wReason} onChange={(e) => setWReason(e.target.value as WithdrawReason)}>
            <option value="" disabled>Select a reason…</option>
            {WITHDRAW_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="withdraw-note">Note{wReason === 'other' ? '' : ' (optional)'}</label>
          <textarea id="withdraw-note" rows={3} placeholder={wReason === 'other' ? 'Explain the reason for withdrawing' : 'Add any context (optional)'} value={wNote} onChange={(e) => setWNote(e.target.value)} />
        </div>
      </Modal>

      {/* #82 SIGNED-DEED CONSEQUENCE CONFIRMATION (stacked on the amend modal) */}
      <Modal
        open={confirmReissueOpen}
        onClose={() => setConfirmReissueOpen(false)}
        width={460}
        title="This deed is signed. Amend anyway?"
        sub="Deed and application data must never disagree, so amending the tenancy start on a signed deed replaces the deed."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReissueOpen(false)}>Cancel</Button>
            <Button variant="primary" className="btn--danger" onClick={() => void saveAmend(true)}>Void, reissue and amend</Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.6, margin: 0 }}>Proceeding will:</p>
        <ul style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.6, margin: '8px 0 0', paddingLeft: 20 }}>
          <li>void and archive the current signed deed;</li>
          <li>issue a corrected deed and send it to the tenant to sign again;</li>
          <li>re-notify the agent once the corrected deed is signed.</li>
        </ul>
      </Modal>

      {/* SEND DEED TO AGENT MODAL */}
      <Modal
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        width={460}
        title="Send deed to agent"
        sub="A copy of the Deed of Guarantee will be emailed to the agent contact for this branch."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSendOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={confirmSend} disabled={sendDisabled}>Send deed</Button>
          </>
        }
      >
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-mute)', marginBottom: 8 }}>Send to</div>

          {isReferrer ? (
            // Referrers are send-only: send to the resolved recipient, with no one-off address or saving.
            resolved.contact ? (
              <>
                <div className="send-opt" style={{ cursor: 'default' }}>
                  <span className="send-opt__main">
                    <b>{resolved.contact.name}</b>{resolved.contact.role ? ` · ${resolved.contact.role}` : ''}
                    <br />
                    <span className="send-opt__email">{resolved.contact.email}{resolved.contact.phone ? ` · ${resolved.contact.phone}` : ''}</span>
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 6 }}>From the {sendSrc}.</div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
                No agent contact is saved for this branch or agency. Ask opndoor or your manager to add one before sending the deed.
              </div>
            )
          ) : (
            <>
              {eff.list.length > 0 ? (
                <>
                  <div className="send-opts">
                    {eff.list.map((c, i) => (
                      <label className="send-opt" key={i}>
                        <input type="radio" name="send-to" checked={sendSel === String(i)} onChange={() => setSendSel(String(i))} />
                        <span className="send-opt__main">
                          <b>{c.name}</b>{c.role ? ` · ${c.role}` : ''}
                          <br />
                          <span className="send-opt__email">{c.email}{c.phone ? ` · ${c.phone}` : ''}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 6 }}>From the {sendSrc}.</div>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 6 }}>
                  No agent contact is saved for this branch or agency. Enter a recipient below, or add one on the{' '}
                  <Link to="/agencies" style={{ color: 'var(--heliotrope-deep)', fontWeight: 700 }}>Agencies and branches</Link> screen.
                </div>
              )}

              <label className="send-opt send-opt--other">
                <input type="radio" name="send-to" checked={sendSel === 'other'} onChange={() => setSendSel('other')} />
                <span className="send-opt__main">
                  <b>Send to another address</b>
                  <br />
                  <span className="send-opt__email">A one-off recipient, not saved to the agency</span>
                </span>
              </label>

              <div className={`send-other${sendSel === 'other' ? ' is-open' : ''}`}>
                <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="field"><label htmlFor="so-name">Name</label><input type="text" id="so-name" autoComplete="off" placeholder="Recipient name" value={soName} onChange={(e) => setSoName(e.target.value)} /></div>
                  <div className="field"><label htmlFor="so-role">Role <span className="hint">Optional</span></label><input type="text" id="so-role" autoComplete="off" placeholder="e.g. Property manager" value={soRole} onChange={(e) => setSoRole(e.target.value)} /></div>
                  <div className="field span-2"><label htmlFor="so-email">Email</label><input type="email" id="so-email" autoComplete="off" placeholder="name@example.co.uk" value={soEmail} onChange={(e) => setSoEmail(e.target.value)} /></div>
                </div>
                <label className="send-save-note"><input type="checkbox" checked={soSave} onChange={(e) => setSoSave(e.target.checked)} /> <span>Also save this contact to the {d.branch} branch</span></label>
              </div>
            </>
          )}

          <p style={{ fontSize: 12.5, color: 'var(--ink-mute)', margin: '14px 0 0' }}>A copy of Guarantee_Deed_{d.ref}.pdf will be emailed to the {isReferrer ? 'recipient above' : 'selected recipient'}.</p>
        </div>
      </Modal>
    </>
  );
}
