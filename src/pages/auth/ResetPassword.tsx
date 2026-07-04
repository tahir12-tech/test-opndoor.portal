/* =====================================================================
   Set-password landing screen for BOTH the password-reset link
   (send-password-reset) and the team-invite link (invite-user). Supabase's
   detectSessionInUrl turns the recovery/invite token in the URL into a session;
   this screen confirms it and takes a new password via auth.updateUser.

   MFA step-up (the fix for #59): a recovery/invite link establishes an AAL1
   session, but Supabase Auth requires an AAL2 session to change the password of
   a user who has an enrolled authenticator. So when the account already has a
   verified TOTP factor (every existing user), we first challenge for the code
   to step the session up to AAL2, THEN update the password. A brand-new invitee
   has no factor yet, so they set a password at AAL1 and enrol TOTP at /login.

   mode='reset':  after saving, sign out -> "Back to sign in" (fresh login).
   mode='invite': after saving, keep the session and go to /login, where the MFA
                  state machine hands the new user into TOTP enrolment.
   ===================================================================== */
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authService } from '@/data';
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import './auth.css';
import '../ForgotPassword/ForgotPassword.css';

type Phase = 'checking' | 'mfa' | 'ready' | 'invalid' | 'done';

const COPY = {
  reset: {
    title: 'Set a new password',
    eyebrow: 'Account recovery',
    brandH1: 'Choose a new password.',
    brandCopy: 'Confirm it is you with your authenticator code, then pick a strong, unique password.',
    invalidLead: 'Your reset link may have expired or already been used. Request a new one and we will email you a fresh link.',
    invalidCta: { to: '/forgot-password', label: 'Request a new link' },
    submitLabel: 'Save new password',
  },
  invite: {
    title: 'Set your password',
    eyebrow: 'Welcome to opndoor',
    brandH1: 'Set your password to get started.',
    brandCopy: 'Pick a strong, unique password. Next you will set up two-factor authentication with an authenticator app, then you are in.',
    invalidLead: 'Your invitation may have expired or already been used. Ask your administrator to resend it.',
    invalidCta: { to: '/login', label: 'Back to sign in' },
    submitLabel: 'Set password and continue',
  },
} as const;

/** Distinct, honest error mapping (#73): password policy, expired/consumed link,
    an AAL/MFA block, or the raw cause, rather than always "link expired". */
function mapUpdateError(msg: string): string {
  const m = (msg || '').toLowerCase();
  if (/aal|assurance|factor|mfa|insufficient/.test(m)) return 'Please verify your authenticator code first, then set your password.';
  if (/reauthentication|nonce/.test(m)) return 'For your security, verify your authenticator code and try again.';
  if (/expired|already|token|invalid|no.*session|session.*missing|not authenticated|unauthorized/.test(m)) {
    return 'This link has expired or was already used. Ask for a fresh one.';
  }
  if (/password|weak|character|length|pwned|breach|strength|at least/.test(m)) {
    return `That password was rejected: ${msg}`;
  }
  return msg ? `We could not set your password: ${msg}` : 'We could not set your password. Please try again.';
}

export function ResetPassword({ mode = 'reset' }: { mode?: 'reset' | 'invite' }) {
  const c = COPY[mode];
  useDocumentTitle(c.title);
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>(SUPABASE_ENABLED ? 'checking' : 'ready');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!SUPABASE_ENABLED) return;
    let settled = false;
    // With a session present, decide whether an AAL2 step-up is needed before the
    // password can be changed (an enrolled factor requires it).
    const decide = async () => {
      if (settled) return;
      const { data } = await sb().auth.getSession();
      if (!data.session) return;
      settled = true;
      try {
        const fs = await authService.factorState();
        if (fs.hasVerifiedFactor && fs.factorId && fs.aal !== 'aal2') { setFactorId(fs.factorId); setPhase('mfa'); }
        else setPhase('ready');
      } catch {
        setPhase('ready');
      }
    };
    const { data: sub } = sb().auth.onAuthStateChange((_evt, session) => { if (session) void decide(); });
    void decide();
    // If no session materialises, the link is invalid/expired.
    const t = setTimeout(() => {
      if (settled) return;
      sb().auth.getSession().then(({ data }) => { if (!settled) { if (data.session) void decide(); else { settled = true; setPhase('invalid'); } } });
    }, 1500);
    return () => { sub.subscription.unsubscribe(); clearTimeout(t); };
  }, []);

  async function verifyMfa(e: FormEvent) {
    e.preventDefault();
    setError('');
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6 || !factorId) { setError('Enter the 6-digit code from your authenticator.'); return; }
    if (busy) return;
    setBusy(true);
    try {
      const r = await authService.verifyCode(factorId, digits);
      if (!r.ok) { setError(r.error ?? 'That code was not right. Try again.'); setCode(''); return; }
      setPhase('ready'); // session is now AAL2
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (pw.length < 8) { setError('Use at least 8 characters.'); return; }
    if (pw !== pw2) { setError('Those passwords do not match.'); return; }
    if (busy) return;
    setBusy(true);
    try {
      if (SUPABASE_ENABLED) {
        const { error: upErr } = await sb().auth.updateUser({ password: pw });
        if (upErr) { setError(mapUpdateError(upErr.message)); return; }
        if (mode === 'invite') {
          // Keep the session: /login advances the new user into TOTP enrolment.
          navigate('/login', { replace: true });
          return;
        }
        await sb().auth.signOut(); // reset: fresh sign-in next (password + TOTP).
      }
      setPhase('done');
    } catch (e2) {
      setError(mapUpdateError(e2 instanceof Error ? e2.message : ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <aside className="auth__brand">
        <div className="auth__brand-top">
          <span className="wordmark">opndoor</span>
          <span className="auth__cobrand">Guarantee<br />Referral Portal</span>
        </div>
        <div className="auth__brand-mid">
          <span className="auth__eyebrow">{c.eyebrow}</span>
          <h1 className="auth__brand-h1">{c.brandH1}</h1>
          <p className="auth__brand-copy">{c.brandCopy}</p>
        </div>
        <div className="auth__flow">
          <div className="auth__flow-item">
            <span className="auth__flow-ic"><Icon name="shield" /></span>
            <div><div className="auth__flow-t">Confirm it is you</div><div className="auth__flow-s">Your authenticator code</div></div>
          </div>
          <div className="auth__flow-item">
            <span className="auth__flow-ic"><Icon name="lock" /></span>
            <div><div className="auth__flow-t">{mode === 'invite' ? 'Set your password' : 'Set a new password'}</div><div className="auth__flow-s">At least 8 characters</div></div>
          </div>
        </div>
      </aside>

      <section className="auth__form-wrap">
        <div className="auth__card">
          {phase === 'checking' && (
            <div>
              <h2 className="auth__title">Checking your link…</h2>
              <p className="auth__sub">One moment while we verify your link.</p>
            </div>
          )}

          {phase === 'invalid' && (
            <div>
              <div className="confirm-ic"><Icon name="alert" strokeWidth={2.4} /></div>
              <h2 className="auth__title">This link is not valid</h2>
              <p className="auth__sub">{c.invalidLead}</p>
              <div className="auth__form">
                <Button variant="primary" block to={c.invalidCta.to}>{c.invalidCta.label}</Button>
              </div>
              <p className="auth__foot"><Link to="/login">Back to sign in</Link></p>
            </div>
          )}

          {phase === 'mfa' && (
            <div>
              <h2 className="auth__title">Confirm it is you</h2>
              <p className="auth__sub">For your security, enter the current 6-digit code from your authenticator app before setting a new password.</p>
              <form className="auth__form" onSubmit={verifyMfa} noValidate>
                <div className="field">
                  <label htmlFor="mfa">Authenticator code</label>
                  <input id="mfa" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required />
                </div>
                {error && <p className="auth__error" role="alert" style={{ color: 'var(--danger, #c0392b)' }}>{error}</p>}
                <Button variant="primary" block type="submit" arrow disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify and continue'}</Button>
              </form>
              <p className="auth__foot">Lost your authenticator? <Link to="/login">Ask your administrator to reset it.</Link></p>
            </div>
          )}

          {phase === 'ready' && (
            <div>
              <h2 className="auth__title">{c.title}</h2>
              <p className="auth__sub">Choose a strong password you do not use elsewhere.</p>
              <form className="auth__form" onSubmit={submit} noValidate>
                <div className="field">
                  <label htmlFor="pw">{mode === 'invite' ? 'Password' : 'New password'}</label>
                  <input id="pw" type="password" autoComplete="new-password" placeholder="At least 8 characters" value={pw} onChange={(e) => setPw(e.target.value)} required />
                </div>
                <div className="field">
                  <label htmlFor="pw2">Confirm password</label>
                  <input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
                </div>
                {error && <p className="auth__error" role="alert" style={{ color: 'var(--danger, #c0392b)' }}>{error}</p>}
                <Button variant="primary" block type="submit" arrow disabled={busy || !pw || !pw2}>{busy ? 'Saving…' : c.submitLabel}</Button>
              </form>
              <p className="auth__foot"><Link to="/login">Back to sign in</Link></p>
            </div>
          )}

          {phase === 'done' && (
            <div>
              <div className="confirm-ic"><Icon name="check" strokeWidth={2.4} /></div>
              <h2 className="auth__title">Password updated</h2>
              <p className="auth__sub">Your password has been changed. Sign in with your new password, then verify with your authenticator code.</p>
              <div className="auth__form">
                <Button variant="primary" block to="/login">Back to sign in</Button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
