import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { login, register, storeToken } from "../games/something2/src/js/net/auth.js";
import { getAuthOptions, requestInvite, forgotPassword } from "../games/something2/src/js/net/accountApi.js";
import { t } from "../games/something2/src/js/i18n/i18n.js";
import { useLang } from "../games/something2/src/js/i18n/useLang.js";
import { Screen, Card, Title, Field, Submit, Toggle, ErrorText, Notice, OkText, Hint } from "./authCard.jsx";
import { loginBannerFor, registerPrefill, errorText } from "./loginModel.js";

// Login screen with four modes: signin | register | request (ask for an invite
// code) | forgot (password reset link). Pure UI + the auth calls; token storage
// lives in net/auth.js and the copy/mapping logic in the unit-tested
// loginModel.js. On success it stores the token and calls onAuthed().
export default function Login({ apiUrl, onAuthed }) {
  useLang();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Read the query once; the banner is shown once and then the URL is cleaned.
  const [initial] = useState(() => ({
    banner: loginBannerFor(searchParams),
    prefill: registerPrefill(searchParams),
  }));
  const [mode, setMode] = useState(initial.prefill.register ? "register" : "signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(initial.prefill.invite);
  const [email, setEmail] = useState(initial.prefill.email);
  const [note, setNote] = useState("");
  const [banner] = useState(initial.banner);
  const [options, setOptions] = useState({ inviteRequests: false });
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // confirmation text after request/forgot
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (searchParams.toString()) navigate(location.pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    getAuthOptions()
      .then((o) => { if (alive && o) setOptions(o); })
      .catch(() => { /* no options: hide the optional links */ });
    return () => { alive = false; };
  }, []);

  const isRegister = mode === "register";
  const isRequest = mode === "request";
  const isForgot = mode === "forgot";
  const isSignin = mode === "signin";

  function go(next) {
    setError(null);
    setDone(null);
    setMode(next);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (isRequest) {
        await requestInvite(email.trim(), note.trim());
        setDone(t("Request received. If it's eligible, we'll email you when an admin reviews it. Not there? Check your spam folder."));
      } else if (isForgot) {
        await forgotPassword(email.trim());
        setDone(t("If an account uses that email, a reset link has been sent. The link works once and expires in 24 hours. Check your spam folder. You can request a new link after an hour."));
      } else {
        // Registering passes the invite code and email; signing in never does.
        const { token } = isRegister
          ? await register(apiUrl, username, password, inviteCode, email)
          : await login(apiUrl, username, password);
        if (!token) throw new Error("no token returned");
        storeToken(token);
        onAuthed();
      }
    } catch (err) {
      setError(errorText(err.code || err.message, err.retryAfterSec));
    } finally {
      setSubmitting(false);
    }
  }

  const title = isRegister ? t("Create account")
    : isRequest ? t("Request an invite code")
    : isForgot ? t("Reset password")
    : t("Sign in");
  const emailOnly = isRequest || isForgot;
  const canSubmit = emailOnly ? !!email.trim() : username && password && (!isRegister || email.trim());

  return (
    <Screen>
      <Card onSubmit={handleSubmit}>
        <Title>{title}</Title>

        {banner && isSignin && (banner.kind === "ok" ? <OkText>{banner.text}</OkText> : <ErrorText>{banner.text}</ErrorText>)}

        {!emailOnly && (
          <>
            <Field
              type="text"
              placeholder={t("Username")}
              value={username}
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
            <Field
              type="password"
              placeholder={t("Password")}
              value={password}
              autoComplete={isRegister ? "new-password" : "current-password"}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}

        {(isRegister || emailOnly) && (
          <Field
            type="email"
            placeholder={t("Email")}
            value={email}
            autoComplete="email"
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        )}

        {/* SOMET-381. Shown only when registering, and optional: a server with
            REGISTRATION_MODE=open ignores it, so the client does not have to
            know the server's mode, and an invite-gated server answers with a
            clear error if it is missing. */}
        {isRegister && (
          <Field
            type="text"
            placeholder={t("Invite code (if you have one)")}
            value={inviteCode}
            autoComplete="off"
            onChange={(e) => setInviteCode(e.target.value)}
          />
        )}

        {isRequest && (
          <Hint
            placeholder={t("Note for the admin (optional)")}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        )}

        {isForgot && !done && <Notice>{t("Enter the email on your account and we'll send a reset link.")}</Notice>}
        {done && <Notice>{done}</Notice>}
        {error && <ErrorText>{error}</ErrorText>}

        {!done && (
          <Submit type="submit" disabled={submitting || !canSubmit}>
            {submitting ? "…" : isRegister ? t("Register")
              : isRequest ? t("Send request")
              : isForgot ? t("Send reset link")
              : t("Log in")}
          </Submit>
        )}

        {(isSignin || isRegister) && (
          <Toggle type="button" onClick={() => go(isRegister ? "signin" : "register")}>
            {isRegister ? t("Have an account? Sign in") : t("Need an account? Register")}
          </Toggle>
        )}
        {(isSignin || isRegister) && (
          <Toggle type="button" onClick={() => go("forgot")}>{t("Forgot password?")}</Toggle>
        )}
        {(isSignin || isRegister) && options.inviteRequests && (
          <Toggle type="button" onClick={() => go("request")}>{t("Request invite code")}</Toggle>
        )}
        {emailOnly && (
          <Toggle type="button" onClick={() => go("signin")}>{t("Back to sign in")}</Toggle>
        )}
      </Card>
    </Screen>
  );
}
