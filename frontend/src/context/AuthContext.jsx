import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { API_URL } from "../config";
import {
  getStoredToken, clearToken, authHeaders, AUTH_EXPIRED_EVENT,
} from "../games/something2/src/js/net/auth.js";
import { deriveAuth } from "./authState";

const AuthContext = createContext(null);

function AuthProvider({ children }) {
  // Source of truth for "who is signed in". Initialised from storage so a page
  // reload keeps the session instead of minting a new anonymous user
  // (SOMET-97); getStoredToken() clears an expired/malformed token itself.
  const [token, setToken] = useState(() => getStoredToken());
  const { authed, isAdmin, username } = useMemo(() => deriveAuth(token), [token]);

  // Login.jsx calls storeToken() itself before invoking onAuthed(), so the
  // default re-reads storage rather than making the caller hand it over twice.
  const signIn = useCallback((next = getStoredToken()) => setToken(next), []);

  const signOut = useCallback(() => {
    clearToken();
    setToken(null);
  }, []);

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
        if (cancelled || res.status !== 401) return;   // network/5xx: keep the session
        signOut();
        toast.error("Session expired — please sign in again");
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
      setToken(null);
      toast.error("Session expired — please sign in again");
    };
    globalThis.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => globalThis.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const value = useMemo(
    () => ({ authed, isAdmin, username, signIn, signOut }),
    [authed, isAdmin, username, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

export { AuthProvider, useAuth };
