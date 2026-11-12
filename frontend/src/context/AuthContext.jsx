import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { API_URL } from "../config";
import {
  getStoredToken, clearToken, authHeaders, AUTH_EXPIRED_EVENT, EMAIL_REQUIRED_EVENT,
} from "../games/something2/src/js/net/auth.js";
import { clearActiveCharacterId } from "../games/something2/characterSession.js";
import { t } from "../games/something2/src/js/i18n/i18n.js";
import { fetchMe } from "../games/something2/src/js/net/accountApi.js";
import { deriveAuth, shouldSignOutOnProbe } from "./authState";

const AuthContext = createContext(null);
const MIN_REFRESH_GAP_MS = 3000;

function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  // Source of truth for "who is signed in". Initialised from storage so a page
  // reload keeps the session instead of minting a new anonymous user
  // (SOMET-97); getStoredToken() clears an expired/malformed token itself.
  const [token, setToken] = useState(() => getStoredToken());
  const { authed, isAdmin, username } = useMemo(() => deriveAuth(token), [token]);
  // The /me JSON ({ email, emailVerified, emailRequired, ... }); null until the
  // first answer. Drives the email gate.
  const [account, setAccount] = useState(null);
  const inflight = useRef(null);
  const lastFetchAt = useRef(0);

  // Re-read /me. Concurrent calls share one request, and unforced calls (window
  // focus, the email-required event) are spaced MIN_REFRESH_GAP_MS apart so a
  // burst of 403s or focus flips can never become a /me storm.
  const refreshAccount = useCallback(({ force = false } = {}) => {
    if (inflight.current) return inflight.current;
    if (!force && Date.now() - lastFetchAt.current < MIN_REFRESH_GAP_MS) return Promise.resolve();
    lastFetchAt.current = Date.now();
    const p = (async () => {
      try {
        const me = await fetchMe();
        if (getStoredToken()) setAccount(me);   // ignore an answer that lands after sign-out
      } catch { /* offline/5xx/401: 401 is handled by apiFetch; keep the last account */ }
      finally { inflight.current = null; }
    })();
    inflight.current = p;
    return p;
  }, []);

  // Login.jsx calls storeToken() itself before invoking onAuthed(), so the
  // default re-reads storage rather than making the caller hand it over twice.
  // We clear the queryClient cache so no cached admin queries or stale character
  // data leak into the new account session.
  const signIn = useCallback((next = getStoredToken()) => {
    queryClient.clear();
    setAccount(null);
    setToken(next);
  }, [queryClient]);

  const signOut = useCallback(() => {
    clearToken();
    // The active character is part of the session, not of the browser. Leaving
    // it behind means the next account to sign in here inherits a stale id and
    // is bounced by the server's ownership check on its first join.
    clearActiveCharacterId();
    queryClient.clear();
    setAccount(null);
    setToken(null);
  }, [queryClient]);

  // A token can be REVOKED while still being well-formed and unexpired: any
  // token_version bump (logout-everywhere, `make admin-password`) leaves the
  // stored JWT parsing fine, so the derivation above happily reports "signed in
  // as admin" while the server 401s every write. That zombie session looks like
  // a broken app -- admin screens render, saving silently fails.
  // Only the server knows about token_version, so ask it once.
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/me`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.ok) {
          lastFetchAt.current = Date.now();
          try { setAccount(await res.json()); } catch { /* non-JSON: leave account null */ }
          return;
        }
        if (!shouldSignOutOnProbe(res.status)) return;   // network/5xx: keep the session
        signOut();
        toast.error(t("Session expired — please sign in again"));
      } catch { /* offline: leave the session alone rather than logging out */ }
    })();
    return () => { cancelled = true; };
  }, [authed, signOut]);

  // The check above only catches a token that was ALREADY dead. A session
  // revoked while this tab is open (someone rotates the admin password, or hits
  // logout-everywhere) is caught here instead: apiFetch clears the token on any
  // 401 and fires this event, so the UI stops pretending to be signed in the
  // moment a request is actually rejected. The token is already cleared from
  // storage by noteAuthFailure, so this only has to drop the in-memory state.
  useEffect(() => {
    const onExpired = () => {
      clearActiveCharacterId();
      queryClient.clear();
      setAccount(null);
      setToken(null);
      toast.error(t("Session expired — please sign in again"));
    };
    globalThis.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => globalThis.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [queryClient]);

  // The server refused a request because the email is unverified: re-read /me
  // so the gate shows. Throttled by refreshAccount.
  useEffect(() => {
    if (!authed) return undefined;
    const onRequired = () => { refreshAccount(); };
    globalThis.addEventListener(EMAIL_REQUIRED_EVENT, onRequired);
    return () => globalThis.removeEventListener(EMAIL_REQUIRED_EVENT, onRequired);
  }, [authed, refreshAccount]);

  const value = useMemo(
    () => ({ authed, isAdmin, username, signIn, signOut, account, refreshAccount }),
    [authed, isAdmin, username, signIn, signOut, account, refreshAccount],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

export { AuthProvider, useAuth };
