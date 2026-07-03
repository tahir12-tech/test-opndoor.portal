/* =====================================================================
   Forgot password — email entry, then a neutral "if an account exists"
   confirmation. UI only.

   PENDING: password reset is still stubbed (authService.requestPasswordReset is
   a no-op). To go live, send the reset email via Supabase (resetPasswordForEmail)
   and add a set-new-password page to consume the redirect token.
   ===================================================================== */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { authService } from '@/data';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import '../auth/auth.css';
import './ForgotPassword.css';

export function ForgotPassword() {
  useDocumentTitle('Reset password');
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    authService.requestPasswordReset(email.trim());
    setSent(true);
  }

  return (
    <div className="auth">
      <aside className="auth__brand">
        <div className="auth__brand-top">
          <span className="wordmark">opndoor</span>
          <span className="auth__cobrand">Guarantee<br />Referral Portal</span>
        </div>
        <div className="auth__brand-mid">
          <span className="auth__eyebrow">Account recovery</span>
          <h1 className="auth__brand-h1">Back into the portal in a moment.</h1>
          <p className="auth__brand-copy">Enter your work email and we will send you a secure link to set a new password. For your security the link expires shortly after it is sent.</p>
        </div>
        <div className="auth__flow">
          <div className="auth__flow-item">
            <span className="auth__flow-ic"><Icon name="mailOpen" /></span>
            <div><div className="auth__flow-t">Check your inbox</div><div className="auth__flow-s">A reset link is sent to your work email</div></div>
          </div>
          <div className="auth__flow-item">
            <span className="auth__flow-ic"><Icon name="lock" /></span>
            <div><div className="auth__flow-t">Set a new password</div><div className="auth__flow-s">Choose a strong, unique password</div></div>
          </div>
          <div className="auth__flow-item">
            <span className="auth__flow-ic"><Icon name="shield" /></span>
            <div><div className="auth__flow-t">Two-factor still applies</div><div className="auth__flow-s">You will verify with your code as usual</div></div>
          </div>
        </div>
      </aside>

      <section className="auth__form-wrap">
        <div className="auth__card">
          {!sent ? (
            <div>
              <Link className="back-link" to="/login">
                <Icon name="arrowLeft" /> Back to sign in
              </Link>
              <h2 className="auth__title" style={{ marginTop: 16 }}>Reset your password</h2>
              <p className="auth__sub">Enter the work email you sign in with and we will send you a link to set a new password.</p>
              <form className="auth__form" onSubmit={submit} noValidate>
                <div className="field">
                  <label htmlFor="email">Work email</label>
                  <input id="email" type="email" placeholder="you@foxglove-residential.co.uk" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <Button variant="primary" block type="submit" arrow>Send reset link</Button>
              </form>
              <p className="auth__foot">Remembered it? <Link to="/login">Back to sign in</Link></p>
            </div>
          ) : (
            <div>
              <div className="confirm-ic"><Icon name="send" strokeWidth={2.4} /></div>
              <h2 className="auth__title">Check your email</h2>
              <p className="auth__sub">If an account exists for that address, we have sent a link to reset your password. It expires in 30 minutes.</p>
              <div className="sent-to"><Icon name="mailOpen" /><span>{email || 'you@foxglove-residential.co.uk'}</span></div>
              <div className="auth__form">
                <Button variant="primary" block to="/login">Back to sign in</Button>
              </div>
              <p className="auth__foot">Didn't get it? Check your spam folder, or <a href="#" onClick={(e) => { e.preventDefault(); }}>send it again</a>. Still stuck? Ask your administrator or use the contact details on the sign-in screen.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
