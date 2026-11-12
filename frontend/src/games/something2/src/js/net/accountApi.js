/**
 * Account-email API: invite requests, forgot/reset password, verification.
 * Each call resolves the parsed JSON body or throws an Error whose `.code` is
 * the server `error` field (or "too_many_requests" for a rate-limit 429) and
 * `.retryAfterSec` when the server says how long to wait.
 */
import { API_URL } from "../../../../../config";
import { authHeaders, apiFetch } from "./auth.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function retryAfterOf(res, data) {
  const fromBody = Number(data && data.retryAfterSec);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const h = res.headers && res.headers.get && res.headers.get("Retry-After");
  const fromHeader = Number(h);
  return Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : undefined;
}

// How long a /me read may take before it counts as failed. Without a bound, a backend that accepts the connection
// and never answers leaves the probe 'pending' and the app blank, even with the gate off.
export const ME_TIMEOUT_MS = 8000;

// Runs fn(signal) and aborts it after `ms`; the timer covers the body read too, as long as fn reads it.
// A timeout surfaces as fn's rejection (an AbortError from fetch).
export async function withTimeout(ms, fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function call(path, { method = "GET", body, authed = false, timeoutMs, cache } = {}) {
  if (timeoutMs) return withTimeout(timeoutMs, (signal) => send(path, { method, body, authed, signal, cache }));
  return send(path, { method, body, authed, cache });
}

async function send(path, { method, body, authed, signal, cache }) {
  const init = { method, headers: authed ? authHeaders() : JSON_HEADERS };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (signal) init.signal = signal;
  if (cache) init.cache = cache;
  const res = await (authed ? apiFetch : fetch)(`${API_URL}${path}`, init);
  let data = {};
  try { data = await res.json(); } catch (e) {
    if (signal && signal.aborted) throw e;   // a timed-out body read is a failure, not an empty answer
    /* non-JSON body (e.g. rate limiter text) */
  }
  if (!res.ok) {
    const code = (data && data.error) || (res.status === 429 ? "too_many_requests" : `HTTP ${res.status}`);
    const err = new Error(code);
    err.code = code;
    const wait = retryAfterOf(res, data);
    if (wait !== undefined) err.retryAfterSec = wait;
    throw err;
  }
  return data;
}

export const getAuthOptions = () => call("/api/auth/options");
export const requestInvite = (email, note) =>
  call("/api/auth/invite-requests", { method: "POST", body: { email, note } });
export const forgotPassword = (email) =>
  call("/api/auth/password/forgot", { method: "POST", body: { email } });
export const checkResetToken = (token) =>
  call(`/api/auth/password/reset/${encodeURIComponent(token)}`);
export const resetPassword = (token, password) =>
  call("/api/auth/password/reset", { method: "POST", body: { token, password } });
export const verifyEmail = (token) =>
  call("/api/auth/verify-email", { method: "POST", body: { token } });
export const setEmail = (email) =>
  call("/api/auth/email", { method: "POST", body: { email }, authed: true });
export const resendVerification = () =>
  call("/api/auth/email/resend", { method: "POST", body: {}, authed: true });
export const fetchMe = () => call("/api/auth/me", { authed: true, timeoutMs: ME_TIMEOUT_MS, cache: "no-store" });
