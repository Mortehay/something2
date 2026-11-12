import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { API_URL } from "../config";
import {
  getStoredToken, clearToken, authHeaders, AUTH_EXPIRED_EVENT, EMAIL_REQUIRED_EVENT,
} from "../games/something2/src/js/net/auth.js";
import { clearActiveCharacterId } from "../games/something2/characterSession.js";
import { t } from "../games/something2/src/js/i18n/i18n.js";
import { fetchMe, withTimeout, ME_TIMEOUT_MS } from "../games/something2/src/js/net/accountApi.js";
import { deriveAuth, shouldSignOutOnProbe, isMeAnswer } from "./authState";

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
  // 'pending' until the first /me answer; 'failed' after a network error,
  // non-401 error status or unreadable body (RequireAuth then fails open).
  const [probeStatus, setProbeStatus] = useState("pending");
  const probeRef = useRef("pending");
  const inflight = useRef(null);
  const lastFetchAt = useRef(0);
  const timer = useRef(null);

  const setProbe = useCallback((next) => {
    probeRef.current = next;
    setProbeStatus(next);
  }, []);

  const readMe = useCallback(async () => {
    lastFetchAt.current = Date.now();
    try {
      const me = await fetchMe();
      if (!getStoredToken()) return;   // ignore an answer that lands after sign-out
      if (!isMeAnswer(me)) throw new Error("not a /me answer");
      setAccount(me);
      setProbe("answered");
    } catch {
      // 401 is handled by apiFetch. Keep a known account; otherwise mark failed.
      if (probeRef.current !== "answered") setProbe("failed");
    }
  }, [setProbe]);

  // Re-read /me. Concurrent calls share one request; `force` queues a FRESH read
  // after the in-flight one (that one may predate the caller's change). Unforced
  // calls closer than MIN_REFRESH_GAP_MS to the last read are deferred to ONE
  // trailing timer, so a burst can never become a /me storm yet no trigger is lost.
  const refreshAccount = useCallback(({ force = false } = {}) => {
    const run = () => {
      const p = readMe().finally(() => { if (inflight.current === p) inflight.current = null; });
      inflight.current = p;
      return p;
    };
    if (inflight.current) return force ? run2(inflight.current) : inflight.current;
    const wait = MIN_REFRESH_GAP_MS - (Date.now() - lastFetchAt.current);
    if (!force && wait > 0) {
      if (!timer.current) {
        timer.current = setTimeout(() => { timer.current = null; refreshAccount(); }, wait);
      }
      return Promise.resolve();
    }
    return run();
    function run2(prev) {
      const p = prev.then(() => readMe()).finally(() => { if (inflight.current === p) inflight.current = null; });
      inflight.current = p;
      return p;
    }
  }, [readMe]);

  useEffect(() => () => { clearTimeout(timer.current); timer.current = null; }, [authed]);

  // A failed probe is retried when the tab regains focus or the network returns,
  // whether or not the EmailGate is mounted.
  useEffect(() => {
    if (!authed) return undefined;
    const retry = () => { if (probeRef.current === "failed") refreshAccount(); };
    globalThis.addEventListener("focus", retry);
    globalThis.addEventListener("online", retry);
    return () => {
      globalThis.removeEventListener("focus", retry);
      globalThis.removeEventListener("online", retry);
    };
  }, [authed, refreshAccount]);

  // Login.jsx calls storeToken() itself before invoking onAuthed(), so the
  // default re-reads storage rather than making the caller hand it over twice.
  // We clear the queryClient cache so no cached admin queries or stale character
  // data leak into the new account session.
  const signIn = useCallback((next = getStoredToken()) => {
    queryClient.clear();
    setAccount(null);
    setProbe("pending");
    setToken(next);
  }, [queryClient, setProbe]);

  const signOut = useCallback(() => {
    clearToken();
    // The active character is part of the session, not of the browser. Leaving
    // it behind means the next account to sign in here inherits a stale id and
    // is bounced by the server's ownership check on its first join.
    clearActiveCharacterId();
    queryClient.clear();
    setAccount(null);
    setProbe("pending");
    setToken(null);
  }, [queryClient, setProbe]);

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
        // Bounded like fetchMe: a hanging backend times out into 'failed' (fail open) instead of a blank app.
        const got = await withTimeout(ME_TIMEOUT_MS, async (signal) => {
          const res = await fetch(`${API_URL}/api/auth/me`, { headers: authHeaders(), signal });
          if (!res.ok) return { status: res.status };
          let me = null;
          try { me = await res.json(); } catch (e) { if (signal.aborted) throw e; }
          return { status: res.status, me };
        });
        if (cancelled) return;
        if (got.status >= 200 && got.status < 300) {
          lastFetchAt.current = Date.now();
          if (isMeAnswer(got.me)) {
            setAccount(got.me);
            setProbe("answered");
          } else setProbe("failed");
          return;
        }
        if (!shouldSignOutOnProbe(got.status)) { setProbe("failed"); return; }   // 5xx: keep the session
        signOut();
        toast.error(t("Session expired — please sign in again"));
      } catch { if (!cancelled) setProbe("failed"); }   // offline or timed out: leave the session alone
    })();
    return () => { cancelled = true; };
  }, [authed, signOut, setProbe]);

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
      setProbe("pending");
      setToken(null);
      toast.error(t("Session expired — please sign in again"));
    };
    globalThis.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => globalThis.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [queryClient, setProbe]);

  // The server refused a request because the email is unverified: re-read /me
  // so the gate shows. Throttled by refreshAccount.
  useEffect(() => {
    if (!authed) return undefined;
    const onRequired = () => { refreshAccount(); };
    globalThis.addEventListener(EMAIL_REQUIRED_EVENT, onRequired);
    return () => globalThis.removeEventListener(EMAIL_REQUIRED_EVENT, onRequired);
  }, [authed, refreshAccount]);

  const value = useMemo(
    () => ({ authed, isAdmin, username, signIn, signOut, account, probeStatus, refreshAccount }),
    [authed, isAdmin, username, signIn, signOut, account, probeStatus, refreshAccount],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

export { AuthProvider, useAuth };
