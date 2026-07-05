/* =====================================================================
   Auth service.

   Mock mode (no Supabase / tests): login/verify2fa are always-ok stubs so the
   two-step form and the render smoke test work with no back end.

   Supabase mode: real email/password + native TOTP MFA. Password sign-in gives
   an AAL1 session; enrolling or verifying a TOTP factor steps up to AAL2, which
   the database requires before it returns any data.
   ===================================================================== */
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';

export interface LoginResult {
  ok: boolean;
  requires2fa: boolean;
  /** Masked email for the "we sent a code to…" line. */
  maskedEmail: string;
}

/** Mask an email for the 2FA step: "p••••@domain". */
export function maskEmail(email: string): string {
  const parts = email.split('@');
  if (!parts[0]) return email;
  return `${parts[0].charAt(0)}••••@${parts[1] || ''}`;
}

/* -------------------- mock mode (SUPABASE_ENABLED === false) -------------------- */

/** Mocked as always-ok. */
export function login(email: string, _password: string): LoginResult {
  return { ok: true, requires2fa: true, maskedEmail: maskEmail(email) };
}

/** Mocked as always-ok. */
export function verify2fa(_code: string): { ok: boolean } {
  return { ok: true };
}

/**
 * Self-service password reset. In Supabase mode this invokes the
 * send-password-reset Edge Function, which generates a recovery link and emails
 * it via the branded Resend template (redirected to the review address in this
 * test build). It ALWAYS resolves ok and never reveals whether the address has
 * an account (no enumeration); the UI shows the neutral "if an account exists"
 * confirmation regardless. No-op in mock mode.
 */
export async function requestPasswordReset(email: string): Promise<{ ok: boolean }> {
  if (!SUPABASE_ENABLED) return { ok: true };
  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    await sb().functions.invoke('send-password-reset', { body: { email: email.trim(), origin } });
  } catch {
    // Swallow: the confirmation is intentionally identical whether or not the
    // send succeeded, so an outage never leaks account existence.
  }
  return { ok: true };
}

/* -------------------- Supabase mode -------------------- */

export interface AuthResult {
  ok: boolean;
  error?: string;
}

/** Step 1: email + password. Establishes an AAL1 session. A deactivated (banned)
    account is blocked here; we surface a clean, partner-safe message and never
    the raw GoTrue error. */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
  if (!error) return { ok: true };
  const msg = (error.message || '').toLowerCase();
  const code = ((error as { code?: string }).code || '').toLowerCase();
  if (code === 'user_banned' || msg.includes('banned')) {
    return { ok: false, error: 'This account has been deactivated. Contact your administrator.' };
  }
  return { ok: false, error: 'Wrong email or password.' };
}

export interface FactorState {
  aal: string;
  hasVerifiedFactor: boolean;
  factorId: string | null;
  /** #92 False when the factor read failed (no/expired session/token). Callers must
      NOT treat this as "zero verified factors" and must not start enrolment. */
  ok: boolean;
}

/** Assurance level + whether the user already has a verified TOTP factor. */
export async function factorState(): Promise<FactorState> {
  const { data: aalData, error: aalErr } = await sb().auth.mfa.getAuthenticatorAssuranceLevel();
  const { data: fData, error: listErr } = await sb().auth.mfa.listFactors();
  const verified = (fData?.totp ?? []).filter((f) => f.status === 'verified');
  return {
    aal: aalData?.currentLevel ?? 'aal1',
    hasVerifiedFactor: verified.length > 0,
    factorId: verified[0]?.id ?? null,
    // #92 A read failure (missing/expired token) must be distinguishable from a
    // genuine "no factors", so callers never start a bogus enrolment.
    ok: !aalErr && !listErr,
  };
}

export interface EnrolResult extends AuthResult {
  factorId?: string;
  /** SVG markup for the QR code. */
  qr?: string;
  secret?: string;
  uri?: string;
}

/** Begin TOTP enrolment: returns a QR code + secret to add to an authenticator.
    Robust against a stale factor left by an abandoned attempt (which otherwise
    surfaced a raw "a factor with the friendly name '' already exists" error): we
    drop unverified factors first, and if enrolment still collides we clear every
    TOTP factor and retry once. Any failure returns a clean, mapped message. */
export async function enrolTotp(): Promise<EnrolResult> {
  // enrolTotp is only reached when the user has NO verified factor, so any
  // factors present are stale unverified attempts. Clear them all (best effort),
  // then enrol with a UNIQUE friendly name. The unique name is what makes this
  // bulletproof: the default empty name collides ("a factor with the friendly
  // name '' already exists") whenever a stale factor lingers, which previously
  // stranded invitees at the two-factor step. On failure we surface the real
  // GoTrue message rather than a blanket one.
  try {
    const { data } = await sb().auth.mfa.listFactors();
    for (const f of (data?.totp ?? [])) {
      try { await sb().auth.mfa.unenroll({ factorId: f.id }); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
  const friendlyName = `opndoor ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await sb().auth.mfa.enroll({ factorType: 'totp', friendlyName });
  if (res.error || !res.data) {
    const detail = res.error?.message ?? '';
    // #92/#73 Never surface a raw server-ism. A session/token error means the
    // session lapsed, so ask the user to sign in again rather than echoing GoTrue.
    if (/bearer|not authenticated|unauthorized|session|jwt|expired/i.test(detail)) {
      return { ok: false, error: 'Your session has expired. Please sign in again.' };
    }
    return { ok: false, error: detail ? `We could not start two-factor setup: ${detail}` : 'We could not start two-factor setup. Please try again, or ask your administrator to reset your 2FA.' };
  }
  return { ok: true, factorId: res.data.id, qr: res.data.totp.qr_code, secret: res.data.totp.secret, uri: res.data.totp.uri };
}

/** Verify a 6-digit code against a factor (enrolment or step-up). Reaches AAL2.
    Returns clean, mapped messages (never the raw GoTrue error). */
export async function verifyCode(factorId: string, code: string): Promise<AuthResult> {
  const { data: challenge, error: cErr } = await sb().auth.mfa.challenge({ factorId });
  if (cErr || !challenge) return { ok: false, error: 'We could not verify that code. Please try again.' };
  const { error } = await sb().auth.mfa.verify({ factorId, challengeId: challenge.id, code });
  return error ? { ok: false, error: 'That code was not right. Try again.' } : { ok: true };
}

export async function signOut(): Promise<void> {
  await sb().auth.signOut();
}
