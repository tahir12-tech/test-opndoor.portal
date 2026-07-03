/* =====================================================================
   Auth service.

   Mock mode (no Supabase / tests): login/verify2fa are always-ok stubs so the
   two-step form and the render smoke test work with no back end.

   Supabase mode: real email/password + native TOTP MFA. Password sign-in gives
   an AAL1 session; enrolling or verifying a TOTP factor steps up to AAL2, which
   the database requires before it returns any data.
   ===================================================================== */
import { sb } from '@/lib/supabase';

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

/** Mocked as a no-op. */
export function requestPasswordReset(_email: string): { ok: boolean } {
  return { ok: true };
}

/* -------------------- Supabase mode -------------------- */

export interface AuthResult {
  ok: boolean;
  error?: string;
}

/** Step 1: email + password. Establishes an AAL1 session. */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export interface FactorState {
  aal: string;
  hasVerifiedFactor: boolean;
  factorId: string | null;
}

/** Assurance level + whether the user already has a verified TOTP factor. */
export async function factorState(): Promise<FactorState> {
  const { data: aalData } = await sb().auth.mfa.getAuthenticatorAssuranceLevel();
  const { data: fData } = await sb().auth.mfa.listFactors();
  const verified = (fData?.totp ?? []).filter((f) => f.status === 'verified');
  return {
    aal: aalData?.currentLevel ?? 'aal1',
    hasVerifiedFactor: verified.length > 0,
    factorId: verified[0]?.id ?? null,
  };
}

export interface EnrolResult extends AuthResult {
  factorId?: string;
  /** SVG markup for the QR code. */
  qr?: string;
  secret?: string;
  uri?: string;
}

/** Begin TOTP enrolment: returns a QR code + secret to add to an authenticator. */
export async function enrolTotp(): Promise<EnrolResult> {
  // Drop any unverified factor left over from an abandoned attempt.
  const { data: existing } = await sb().auth.mfa.listFactors();
  for (const f of (existing?.totp ?? []).filter((x) => x.status !== 'verified')) {
    await sb().auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await sb().auth.mfa.enroll({ factorType: 'totp' });
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not start enrolment' };
  return { ok: true, factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
}

/** Verify a 6-digit code against a factor (enrolment or step-up). Reaches AAL2. */
export async function verifyCode(factorId: string, code: string): Promise<AuthResult> {
  const { data: challenge, error: cErr } = await sb().auth.mfa.challenge({ factorId });
  if (cErr || !challenge) return { ok: false, error: cErr?.message ?? 'Could not start verification' };
  const { error } = await sb().auth.mfa.verify({ factorId, challengeId: challenge.id, code });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function signOut(): Promise<void> {
  await sb().auth.signOut();
}
