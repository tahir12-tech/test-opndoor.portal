/* =====================================================================
   Session context — the seam between authentication and the app.

   Mock mode (no Supabase / tests): the demo role switcher drives role and
   the mock service data is used. Status is always "ready", no gate.

   Supabase mode: the real session drives everything. Password sign-in is
   AAL1; only after TOTP step-up (AAL2) do we load the user's profile, pin the
   home partner, seed the role, and hydrate the service layer from the DB. The
   dev role switcher remains (a UI lens; data stays RLS-scoped to the session).
   ===================================================================== */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ALL_PARTNERS, authService, getSelectedPartner, homePartner, setHomePartner,
  setSelectedPartner as persistPartner, getSelectedPeriod, setSelectedPeriod as persistPeriod,
  type PartnerScope, type Period, type Role,
} from '@/data';
import { KEYS, loadString, saveString } from '@/data/storage';
import { ROLES, type RoleIdentity } from '@/constants/roles';
import { SUPABASE_ENABLED, supabase } from '@/lib/supabase';
import { hydrateFromSupabase } from '@/lib/hydrate';
import { anyTabAlive, clearSessionAlive, sessionRecentlyAlive, startHeartbeat, stopHeartbeat } from '@/session/browserSession';

export type SessionStatus = 'loading' | 'signedOut' | 'needsMfa' | 'ready';

interface Profile {
  userId: string;
  role: Role;
  name: string;
  email: string;
  partner: string | null;
}

interface SessionValue {
  role: Role;
  /** Demo/dev switcher — a UI lens in Supabase mode (data stays RLS-scoped). */
  setRole: (role: Role) => void;
  /** The signed-in identity (sidebar footer, activity). */
  user: RoleIdentity;
  /** The signed-in user's id (Supabase mode), for self-action guards. Null in mock mode. */
  currentUserId: string | null;
  partnerScope: PartnerScope;
  selectedPartner: PartnerScope;
  setSelectedPartner: (id: PartnerScope) => void;
  period: Period;
  setPeriod: (id: string) => void;
  /** Auth (Supabase mode). In mock mode: status is always "ready". */
  status: SessionStatus;
  authError: string | null;
  /** Mark TOTP as freshly verified in this runtime (called by Login on a
      successful code). Grants AAL2 trust that a restored session cannot forge. */
  markMfaVerified: () => void;
  signOut: () => Promise<void>;
  /** Re-load the RLS-scoped datasets after a mutation (no-op in mock mode). */
  refresh: () => Promise<void>;
  /** Bumped whenever the working copies re-hydrate; use in memo deps to recompute
      derived views (e.g. an application detail) after a mutation + refresh(). */
  dataVersion: number;
}

const SessionContext = createContext<SessionValue | null>(null);

function initialRole(): Role {
  const r = loadString(KEYS.role);
  return r === 'superadmin' || r === 'management' || r === 'referrer' ? r : 'superadmin';
}

function initialsOf(name: string): string {
  return name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const emb = (x: any): any => (Array.isArray(x) ? x[0] : x);

// In-memory (per-runtime, NON-persisted) proof that this runtime's AAL2 session
// is trusted — set once we either resume a still-live browser session or verify
// a fresh TOTP. It resets on every fresh page load, so it can never be restored
// from storage; the shared token in localStorage is inert without it.
let mfaTrustedThisRuntime = false;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<Role>(initialRole);
  const [selectedPartner, setSelectedPartnerState] = useState<PartnerScope>(() => getSelectedPartner());
  const [period, setPeriodState] = useState<Period>(() => getSelectedPeriod());
  const [status, setStatus] = useState<SessionStatus>(SUPABASE_ENABLED ? 'loading' : 'ready');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // Bumped once hydration completes so any background re-hydration (session
  // refresh, a mutation's refresh()) forces consumers to re-read live data.
  const [dataVersion, setDataVersion] = useState(0);
  const hydratedFor = useRef<string | null>(null);
  // The single in-flight hydration for a user. Concurrent resolve() calls (mount
  // + onAuthStateChange) await THIS promise rather than racing ahead to 'ready'
  // while the working copies still hold mock data.
  const hydration = useRef<{ userId: string; promise: Promise<void> } | null>(null);

  const setRole = useCallback((next: Role) => {
    saveString(KEYS.role, next);
    setRoleState(next);
  }, []);

  const setSelectedPartner = useCallback((id: PartnerScope) => {
    persistPartner(id);
    setSelectedPartnerState(id);
  }, []);

  const setPeriod = useCallback((id: string) => {
    persistPeriod(id);
    setPeriodState(getSelectedPeriod());
  }, []);

  // Resolve the Supabase session -> status, and hydrate once at AAL2.
  const resolve = useCallback(async () => {
    if (!SUPABASE_ENABLED || !supabase) {
      setStatus('ready');
      return;
    }
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setProfile(null);
        setStatus('signedOut');
        return;
      }
      const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if ((aalData?.currentLevel ?? 'aal1') !== 'aal2') {
        setStatus('needsMfa');
        return;
      }
      // The token in localStorage is shared across tabs and survives a browser
      // quit, so a stored AAL2 level is not sufficient on its own. Trust it only
      // when this runtime already verified TOTP, OR when a tab was recently alive
      // (a same-tab refresh or a new tab of a still-live session): a fresh heartbeat
      // stamp, or — if the stamp looks stale because a backgrounded tab's timer was
      // throttled — a live tab answering the liveness ping. A cold start after a
      // full quit has neither, so we force a fresh TOTP challenge.
      if (!mfaTrustedThisRuntime) {
        if (sessionRecentlyAlive() || (await anyTabAlive())) {
          mfaTrustedThisRuntime = true;
        } else {
          setStatus('needsMfa');
          return;
        }
      }
      // Trusted: keep the heartbeat fresh so other tabs and the next refresh resume.
      startHeartbeat();
      const userId = session.user.id;
      const { data, error } = await supabase
        .from('users')
        .select('role, full_name, email, status, partner:partners(slug)')
        .eq('id', userId)
        .single();
      if (error || !data) {
        setAuthError(error?.message ?? 'Could not load your profile.');
        setStatus('needsMfa');
        return;
      }
      // Deactivated mid-session: the ban revoked their refresh token, but a
      // still-valid access token could otherwise linger until it expires. Sign
      // out immediately on any app load so deactivation takes effect at once.
      if ((data.status as string) === 'deactivated') {
        await supabase.auth.signOut();
        mfaTrustedThisRuntime = false;
        stopHeartbeat();
        clearSessionAlive();
        hydratedFor.current = null;
        hydration.current = null;
        setProfile(null);
        setAuthError('This account has been deactivated. Contact your administrator.');
        setStatus('signedOut');
        return;
      }
      const prof: Profile = {
        userId,
        role: data.role as Role,
        name: data.full_name as string,
        email: data.email as string,
        partner: emb(data.partner)?.slug ?? null,
      };
      if (prof.partner) setHomePartner(prof.partner);
      setProfile(prof);
      setRole(prof.role);
      if (hydratedFor.current !== userId) {
        // #100 A seat change within the same runtime (a DIFFERENT user resolves
        // without an in-app sign-out, e.g. the auth token was swapped) must not
        // inherit the prior admin's persisted partner scope. Reset to All. (A
        // first-ever hydration has hydratedFor.current === null, so a same-user
        // reload keeps their own saved selection.)
        if (hydratedFor.current !== null && hydratedFor.current !== userId) {
          persistPartner(ALL_PARTNERS);
          setSelectedPartnerState(ALL_PARTNERS);
        }
        // Start hydration exactly once per user; concurrent resolves reuse and
        // await the same promise. Critically, 'ready' is only set AFTER this
        // resolves, so the app never renders the mock working copies in live mode.
        if (hydration.current?.userId !== userId) {
          hydration.current = { userId, promise: hydrateFromSupabase(userId) };
        }
        try {
          await hydration.current.promise;
        } catch (e) {
          hydration.current = null; // allow a later resolve() to retry
          throw e;
        }
        hydratedFor.current = userId;
        setDataVersion((v) => v + 1);
      }
      setAuthError(null);
      setStatus('ready');
    } catch (e) {
      hydratedFor.current = null;
      hydration.current = null; // drop any cached promise so the next resolve() re-hydrates
      setAuthError(e instanceof Error ? e.message : 'Sign-in failed.');
      setStatus('needsMfa');
    }
  }, [setRole]);

  useEffect(() => {
    if (!SUPABASE_ENABLED || !supabase) return;
    void resolve();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      void resolve();
    });
    return () => sub.subscription.unsubscribe();
  }, [resolve]);

  const markMfaVerified = useCallback(() => {
    mfaTrustedThisRuntime = true;
    // Fresh TOTP verified: begin the heartbeat so a new tab or the next refresh
    // resumes without re-authenticating (until the browser is fully closed).
    startHeartbeat();
  }, []);

  const signOut = useCallback(async () => {
    if (SUPABASE_ENABLED) {
      hydratedFor.current = null;
      // Drop the cached hydration promise: signing back in (even as the same
      // user, in-page with no reload) must re-fetch, not replay a stale snapshot.
      hydration.current = null;
      // Revoke AAL2 trust and stop/forget the heartbeat: a fresh sign-in must
      // re-verify TOTP, and a new tab must not resume off a stale liveness stamp.
      mfaTrustedThisRuntime = false;
      stopHeartbeat();
      clearSessionAlive();
      // #100 Reset the partner scope to All on sign-out. It is persisted in
      // localStorage, so without this the next seat (a different opndoor admin
      // signing in) inherits the prior admin's scope. Clear BOTH the persisted
      // value and the React state, since init re-reads localStorage.
      persistPartner(ALL_PARTNERS);
      setSelectedPartnerState(ALL_PARTNERS);
      await authService.signOut();
      setProfile(null);
      setStatus('signedOut');
    }
  }, []);

  const refresh = useCallback(async () => {
    if (SUPABASE_ENABLED && hydratedFor.current) {
      await hydrateFromSupabase(hydratedFor.current);
    }
    // #10 Always bump dataVersion so memoised derived views (e.g. the application
    // detail) recompute after a mutation. In mock/demo mode there is nothing to
    // re-hydrate, but the working copies were mutated in place, so the bump is what
    // makes every surface reflect the change.
    setDataVersion((v) => v + 1);
  }, []);

  // Expose the role on <html> for role-scoped CSS (mirrors portal.js).
  useEffect(() => {
    document.documentElement.setAttribute('data-role', role);
  }, [role]);

  const partnerScope = role === 'superadmin' ? selectedPartner : homePartner();

  const user: RoleIdentity = profile
    ? { name: profile.name, label: ROLES[profile.role].label, initials: initialsOf(profile.name) }
    : ROLES[role];

  const value = useMemo<SessionValue>(
    () => ({ role, setRole, user, currentUserId: profile?.userId ?? null, partnerScope, selectedPartner, setSelectedPartner, period, setPeriod, status, authError, markMfaVerified, signOut, refresh, dataVersion }),
    // dataVersion is intentionally a dep: bumping it after (re-)hydration changes
    // the context identity so consumers re-read the refreshed working copies.
    [role, setRole, user, profile, partnerScope, selectedPartner, setSelectedPartner, period, setPeriod, status, authError, markMfaVerified, signOut, refresh, dataVersion],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}

export { ALL_PARTNERS };
